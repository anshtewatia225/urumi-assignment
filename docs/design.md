# System design and tradeoffs

## Components and responsibilities

| Component | Namespace | Responsibility |
|---|---|---|
| WordPress + WooCommerce | `store` | Storefront, checkout, admin. Data on a PVC; MariaDB on its own PVC. |
| WooCommerce MCP server | `store` | Exposes products and orders as MCP tools over Streamable HTTP. Talks to the store through the WooCommerce REST API. ClusterIP only. |
| Fulfillment MCP server (mock) | `platform` | In-cluster upstream for cross-server prompts. Intentionally reuses the `list_orders` tool name to demonstrate collision handling. |
| Analytics MCP server (mock) | `platform` | Second in-cluster upstream, same image with a different profile (`sales_summary`, `top_products`, `customer_count`). Keeps three upstreams connected without internet access. |
| DeepWiki MCP | external | Optional public Streamable HTTP MCP server, registered by URL. May show `unreachable` where outbound access to it is blocked; the other servers keep working. |
| Gateway | `platform` | MCP client to every enabled upstream, and one MCP server to clients. Owns users, keys, server registry, audit and the chat tool loop. |
| Dashboard | `platform` | React SPA. Admin views for servers, members and audit; self-service keys; chat. |
| PostgreSQL | `platform` | Users, hashed API keys, upstream registry (with encrypted credentials), audit log. |

Only the gateway holds upstream credentials. Only the gateway and dashboard are reachable
through Ingress. Upstream MCP services are ClusterIP and NetworkPolicy-protected.

## Data model

- `users(id, email, name, role, password_hash)`, roles `admin` and `member`.
- `api_keys(id, user_id, name, prefix, last4, key_hash, last_used_at, revoked_at)`.
  Full keys are shown once and stored as SHA-256 hashes.
- `upstream_servers(id, name, slug, url, auth_type, auth_header_name, auth_secret, enabled)`.
  `auth_secret` is AES-256-GCM ciphertext with a per-secret IV.
- `audit_log(id, user_id, user_email, server_slug, server_name, tool_name, exposed_tool_name,
  source, success, duration_ms, error, created_at)`.

## Authentication and authorization

Two separate credential paths:

1. **Dashboard users** authenticate with email/password. Passwords use scrypt with a random
   salt. A signed, httpOnly session cookie (HMAC/JWT, 12h) identifies the user. Admins manage
   servers and members; members can only manage their own keys, see their own audit rows, and
   use tools.
2. **MCP clients** authenticate with `Authorization: Bearer gw_...` (or `X-API-Key`). The
   gateway hashes the presented token and looks it up; revoked keys are rejected before any
   routing happens.

The MCP endpoint and the chat endpoint converge on the same routing table. The audit row's
`source` distinguishes external MCP calls from chat calls, but both are attributed to the
authenticated user.

## Tool aggregation, routing and collisions

- On each `tools/list` (cached for 15s), the gateway lists tools from all enabled upstreams in
  parallel. Each upstream listing is capped at 5s; failures are isolated.
- Exposed name: `<slug>__<tool>`, for example `woocommerce__list_orders`. Slugs are generated
  from the display name, sanitized to `[a-z0-9_]`, de-duplicated with numeric suffixes, and
  unique in the database. A tool is routed by splitting the exposed name on the first `__`
  and resolving the slug to a server id.
- A meta-tool, `gateway__list_servers`, reports server status and exposed tool names. The
  `gateway` slug is reserved conceptually for meta-tools.
- When a server is disabled or deleted, its tools disappear from the next listing because the
  listing is derived from the registry, not a static config.

Alternative considered: keeping original names and rejecting duplicate names. That cannot
satisfy "two servers may expose a tool with the same name" while still exposing both, so
slug-prefixing was chosen instead. It is deterministic, stable across restarts, and valid
for LLM function names (`[a-zA-Z0-9_-]`).

## Failure handling and timeouts

- `tools/list` per upstream: 5s connect + 5s listing, enforced with `Promise.race` plus the
  transport's abort signal. One failing server yields `status = unreachable` and empty tools;
  other servers still list.
- `tools/call`: 5s connect + 30s call. Errors are returned to the MCP client as a tool result
  with `isError: true` and a clear message, and are written to the audit log with the duration
  and error text.
- Health is shown in the dashboard per server: `connected`, `unreachable`, `disabled`. The
  dashboard refresh ("Probe") invalidates the cache for one server and re-lists its tools.
- Upstream client connections are ephemeral: connect, list or call, close. This keeps the
  gateway stateless, tolerates upstream restarts and pod kills without stale connection state,
  and makes horizontal scaling later a matter of increasing replicas. The cost is one
  connection handshake per call, which is acceptable for an internal tool gateway.
- Gateway startup: the schema check retries with exponential backoff (60 attempts, 0.5s–5s) and
  the pool sets a 5s connect timeout, so a gateway that starts before Postgres (for example
  after a node or cluster restart) waits and then converges instead of crash-looping. While the
  database is down, `/readyz` returns 503 so the pod stays out of service but alive.

## Chat tool loop

`POST /api/chat` requires a dashboard session and streams Server-Sent Events:

1. Load the same aggregated tools the MCP endpoint would expose, plus `gateway__list_servers`.
2. Convert them to OpenAI-style function tools with the prefixed names.
3. Call an OpenAI-compatible chat completions endpoint (`LLM_BASE_URL`, `LLM_MODEL`,
   `LLM_API_KEY`; defaults to OpenRouter).
4. Stream `tool_call` events, execute each call through the gateway's router, write audit rows
   with `source = chat`, stream `tool_result`, and append the results to the conversation.
5. Repeat up to `LLM_MAX_ITERATIONS`, then stream the final assistant message.

The system prompt includes the current UTC time so the model can compute "today" bounds for
`list_orders`. The model is not trusted for authorization: it can only call tools that the
logged-in user could call through the gateway, and the gateway still enforces key revocation
and server enablement.

## Kubernetes design

- **Namespaces**: `store` (WordPress, MariaDB, WooCommerce MCP) and `platform` (gateway,
  dashboard, PostgreSQL, fulfillment MCP).
- **Secrets**: generated by the umbrella chart, preserved on upgrade with `lookup`. The
  credential encryption key is 32 random bytes base64 (`randBytes 32`). No secret appears in
  source or values.
- **Storage**: WordPress (`/var/www/html`), MariaDB (`/var/lib/mysql`) and PostgreSQL
  (`/var/lib/postgresql/data`) use PVCs. kind gets a default `local-path` StorageClass from
  `local-path-provisioner`; k3s ships `local-path` by default.
- **Ingress**: `store.local` routes to WordPress. `app.local` routes `/api` and `/mcp` to the
  gateway and `/` to the dashboard. Proxy buffering is disabled for streaming SSE.
- **Probes and resources**: every Deployment has readiness and liveness probes and explicit
  requests/limits. Node workloads run as non-root with a read-only root filesystem and all
  capabilities dropped. WordPress/MariaDB keep their upstream images' users because Apache
  and MariaDB need them; they do get `fsGroup` for volume access and no added privileges.
- **NetworkPolicies** (deny by default in both namespaces):
  - Storefront ingress from `ingress-nginx`; WordPress ingress also from the WooCommerce MCP.
  - MariaDB ingress only from WordPress and the bootstrap Job.
  - WooCommerce MCP ingress only from gateway pods in `platform`; egress only to WordPress.
  - Gateway egress to WordPress, WooCommerce MCP, PostgreSQL, fulfillment MCP, DNS, and public
    HTTPS for the LLM and public MCP servers.
  - PostgreSQL and fulfillment MCP ingress only from the gateway.
  - Dashboard ingress only from `ingress-nginx`.

The result: the WooCommerce MCP server is unreachable from outside the cluster and from other
workloads, and one store's MCP path cannot reach unrelated pods.

NetworkPolicy enforcement depends on the CNI. k3s enforces NetworkPolicy out of the box;
kind's default kindnet may not. For a strict local isolation demo, install Calico in kind or
run the same charts on k3s. Outside reachability of upstream services does not depend on the
CNI: `wc-mcp`, `mock-mcp` and `analytics-mcp` have no Ingress and are ClusterIP-only.

## How the WooCommerce MCP server talks to the store

The MCP server calls the WooCommerce REST API (`/wp-json/wc/v3`). Basic auth (consumer
key/secret query parameters) is only accepted by WooCommerce for SSL requests, and the MCP
server talks to WordPress over plain HTTP inside the cluster. The client therefore uses OAuth
1.0a one-legged signing (HMAC-SHA256): the consumer key identifies the request, and the secret
signs it and is never transmitted. The signing base uses the public store host from
`WOOCOMMERCE_OAUTH_BASE_URL` (WP_HOME) while the request is sent to the in-cluster Service, so
the signature matches what WooCommerce computes.

REST was chosen over WP-CLI because it returns structured JSON, has a stable versioned
contract, and does not require executing shell commands inside WordPress on every tool call.

## Local to production

The same chart is used. `values-local.yaml` and `values-prod.yaml` change only:

- domain names and Ingress hosts
- TLS enablement and certificate Secret names / cert-manager annotation
- StorageClass name
- image registry/tags
- `cookieSecure`

`scripts/vps-setup.sh` installs k3s with Traefik disabled, ingress-nginx and cert-manager.
The gateway is stateless and the database is a singleton with a PVC, which matches a
single-node VPS. Multi-replica scaling later needs shared session state, but MCP clients are
already key-authenticated per request, and the MCP endpoint itself is stateless.

## Upgrades and rollback

Helm owns all resources across both namespaces through the umbrella chart. The bootstrap Job
is a post-install/post-upgrade hook with `before-hook-creation`, so it re-runs idempotently and
avoids Job immutability errors. PVCs and Secrets are preserved across upgrades. Rollback is
`helm rollback urumi <revision>`; image tags in values make the rollback target explicit.
