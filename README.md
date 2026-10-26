# Urumi MCP Gateway

A WooCommerce hosting platform with a team MCP gateway on Kubernetes. One admin registers
upstream MCP servers once; every team member then uses all of them through a single MCP
endpoint and through a chat agent in the dashboard.

Everything runs in the cluster and deploys with the same Helm chart to kind/k3d locally and
to k3s on a VPS. Local and production differ only through values files.

## Architecture

```
                         +--------------------------- app.local ---------------------------+
  browser / MCP client   |                                                                 |
  (Claude Code, Cursor)  |   Ingress (nginx)                                               |
          |              |     /         -> dashboard (React SPA)                          |
          +----------------->  /api      -> gateway backend (REST + chat SSE)              |
                         |     /mcp      -> gateway backend (streamable HTTP MCP)          |
                         +--------------------------------|-------------------------------+
                                                          |
                                             +------------v-------------+
                                             |  gateway (namespace:     |
                                             |  platform)               |
                                             |  - MCP server (aggregates)|
                                             |  - MCP client to upstreams|
                                             |  - auth, audit, chat loop |
                                             +--+------+------+----------+
                                                |      |      |      |
                     +--------------------------+      |      |      +--------------------------+
                     |                                 |      |                                 |
          +----------v-----------+   +-----------------v------+   +----------------v---------+   +-----------v----------+
          | WooCommerce MCP      |   | Fulfillment MCP (mock) |   | Analytics MCP (mock)    |   | DeepWiki MCP         |
          | (namespace: store)   |   | (namespace: platform)  |   | (namespace: platform)   |   | (public HTTPS)       |
          | ClusterIP only       |   | reuses `list_orders`   |   | sales/customers tools   |   | optional, third-party|
          +----------+-----------+   +------------------------+   +-------------------------+   +----------------------+
                     |
       +-------------v--------------+      +-----------------------+
       | WordPress + WooCommerce    |<---->| MariaDB (PVC)         |
       | Ingress: store.local       |      | store namespace       |
       | PVC /var/www/html          |      | PVC /var/lib/mysql    |
       +----------------------------+      +-----------------------+

  platform namespace also runs PostgreSQL (PVC) for users, keys, servers and audit log.
```

### Tool naming and collisions

The gateway exposes every upstream tool as `<server-slug>__<tool-name>`, for example
`woocommerce__list_orders` and `fulfillment__list_orders`. Slugs are unique in the database,
so two upstreams that expose the same tool name never collide. The
`gateway__list_servers` meta-tool reports which servers are connected. This scheme is
documented in `docs/design.md`.

## Repository layout

```
apps/
  wc-mcp-server/   TypeScript MCP server exposing WooCommerce REST tools (Streamable HTTP)
  mock-mcp/        In-cluster mock MCP server with two profiles: `fulfillment` (reuses
                   `list_orders`) and `analytics` (sales/customer tools)
  gateway/         MCP aggregation, auth, audit, REST API and LLM chat loop
  dashboard/       React + Vite dashboard (servers, members, keys, audit, chat)
charts/
  postgres/  woocommerce/  wc-mcp/  mock-mcp/  gateway/   subcharts
  platform/                                               umbrella chart
values-local.yaml  values-prod.yaml                       local / production values
scripts/           kind-up, build-images, install, vps-setup (+ PowerShell twins)
docs/
  design.md         system design and tradeoffs (required note)
  threat-model.md   threat model (required note)
.env.example       LLM key and other configuration placeholders
```

## Prerequisites

Local:

- Docker Desktop (WSL2 backend on Windows) with at least 6 GB RAM allocated
- `kind`, `kubectl`, `helm` (>= 3.14)
- Ports 80 and 443 free on the host

Production-like:

- A VPS (2 vCPU / 4 GB is enough) with a public IP
- A domain you can point at it
- `helm` and `kubectl` on the VPS (installed by `scripts/vps-setup.sh`)

## Local setup (kind)

```bash
# 1. Create the cluster, ingress-nginx and a default StorageClass
./scripts/kind-up.sh

# 2. Add local DNS. On Linux/macOS:
echo "127.0.0.1 store.local app.local" | sudo tee -a /etc/hosts
# On Windows (Administrator PowerShell): edit C:\Windows\System32\drivers\etc\hosts
#   127.0.0.1 store.local app.local

# 3. Build images and load them into kind
./scripts/build-images.sh

# 4. Deploy. Pass an OpenRouter-compatible key so the chat agent works.
./scripts/install.sh --set secrets.llm.apiKey="$LLM_API_KEY"
```

Windows PowerShell equivalents: `.\scripts\kind-up.ps1`, `.\scripts\build-images.ps1`, then
`.\scripts\install.ps1 --set "secrets.llm.apiKey=$env:LLM_API_KEY"`.

The install scripts run `helm dependency build charts/platform` first, so the subcharts are
vendored from the local `charts/` directory and no chart repository is needed.

The WordPress/WooCommerce bootstrap runs as a Helm post-install Job. Watch it finish:

```bash
kubectl -n store get jobs -w
```

Then:

- Storefront: <http://store.local>
- Dashboard: <http://app.local>
- Gateway MCP endpoint: `http://app.local/mcp`

Credentials are generated at install time and stored in Kubernetes Secrets:

```bash
# Dashboard admin (email defaults to admin@urumi.local)
kubectl -n platform get secret gateway-secrets -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d

# WooCommerce admin (user: admin)
kubectl -n store get secret store-credentials -o jsonpath='{.data.WP_ADMIN_PASSWORD}' | base64 -d

# WooCommerce REST consumer key/secret used by the MCP server
kubectl -n store get secret store-credentials -o jsonpath='{.data.WC_CONSUMER_KEY}' | base64 -d
```

No secret is committed in source or values files. Secrets are generated with `randAlphaNum`
/ `randBytes` and preserved across upgrades via `lookup`.

## Using the system

### Place an order (storefront)

1. Open <http://store.local>.
2. Add a product to the cart and check out.
3. Choose **Cash on delivery** and submit the order.
4. Confirm it in WooCommerce admin: <http://store.local/wp-admin> (user `admin`, password above).

Two sample products are created by the bootstrap Job. Cash on delivery is enabled
automatically, so no payment gateway is needed.

### Chat agent

Sign in to <http://app.local> and open **Chat agent**. The agent runs a server-side tool loop
through the same gateway routing table, so every tool call is audited under the signed-in
user (`source = chat`). Tool calls and their results are shown inline in the conversation.

Example prompts:

- "Create a product called Urumi Hoodie with price 49.90."
- "What orders came in today?"
- "Create a shipment for order 12 to Berlin with DHL."

### Configuring the LLM key

The chat agent needs an OpenAI-compatible key (default provider: OpenRouter). The canonical
variable name is `LLM_API_KEY` (this is what `.env` uses); `OPENROUTER_API_KEY` is accepted as
an alias. Provide it in either place before deploying:

```powershell
# shell environment
$env:LLM_API_KEY="sk-or-..."

# or a gitignored .env at the repo root
LLM_API_KEY=sk-or-...
```

`scripts/install.ps1` and `scripts/install.sh` pick the key up automatically from the
environment or `.env` and pass it as `secrets.llm.apiKey`. You can also pass it explicitly:

```powershell
.\scripts\install.ps1 --set "secrets.llm.apiKey=$env:LLM_API_KEY"
```

Do not put the key in `values-local.yaml` or `values-prod.yaml`; those files are tracked.

Changing the key (or any Secret) later does not need a manual restart: every Helm upgrade bumps
a pod-template annotation on the gateway and the WooCommerce MCP server, so they roll and
re-read the Secret.

The default model is `nvidia/nemotron-3-ultra-550b-a55b:free`. Free model slugs change over
time; if chat returns `LLM request failed (404): This model is unavailable for free`, pick
another free tool-capable model from <https://openrouter.ai/models> and set it:

```powershell
.\scripts\install.ps1 --set gateway.llm.model="<provider/model:free>"
```

### External MCP client (Claude Code / Cursor / MCP Inspector)

1. In the dashboard, open **My API keys** and issue a key. Copy it once; it is stored hashed.
2. Configure the client with only the gateway URL and the key.

Claude Code / JSON-style clients:

```json
{
  "mcpServers": {
    "urumi-gateway": {
      "type": "http",
      "url": "http://app.local/mcp",
      "headers": { "Authorization": "Bearer gw_xxx_yyy" }
    }
  }
}
```

MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP
# URL: http://app.local/mcp
# Header: Authorization: Bearer gw_xxx_yyy
```

The tool list contains every enabled upstream, prefixed with the server slug. Members never
see or configure upstream credentials.

### Admin controls

- **Servers**: add a Streamable HTTP URL with optional bearer or custom-header credential,
  edit, probe, disable, or remove. Disabled servers disappear from every client immediately.
- **Members**: invite users (a temporary password is shown once), change roles, delete,
  and issue or revoke keys on their behalf.
- **Audit log**: filter by tool and source; each row has user, server, tool, timestamp,
  duration, outcome and error. Members see only their own calls.
- **My API keys**: self-service issue/revoke.

### Definition-of-done checks

- Revoke a member's key: their next `/mcp` call returns `401` and nothing is routed.
- Disable an upstream: its tools vanish from `tools/list` and chat.
- Kill an upstream pod:
  `kubectl -n platform delete pod -l app.kubernetes.io/name=mock-mcp`
  The other servers keep working; the dashboard shows the server as `unreachable`.
- Every call above appears in the audit log with the correct user.

## Production-like deployment (k3s on a VPS)

1. Provision the server and point DNS A records (for example `store.example.com` and
   `app.example.com`) at its public IP.
2. Run `scripts/vps-setup.sh`. It installs k3s (Traefik disabled), Helm, ingress-nginx and
   cert-manager.
3. Create a `ClusterIssuer` named `letsencrypt-prod`:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
EOF
```

4. Build the four images and push them to a registry, then update the image names in
   `values-prod.yaml` (or pass `--set`).
5. Deploy:

```bash
VALUES=values-prod.yaml ./scripts/install.sh \
  --set secrets.llm.apiKey="$LLM_API_KEY"
```

What changes between local and production is configuration only:

| Concern | Local (`values-local.yaml`) | Production (`values-prod.yaml`) |
|---|---|---|
| Domains | `store.local`, `app.local` via hosts file | real DNS names |
| TLS | off | cert-manager / Let's Encrypt at Ingress |
| StorageClass | cluster default (local-path) | explicitly `local-path` (k3s default) |
| Images | kind-loaded `:local` tags | registry image tags |
| Cookies | non-secure | `cookieSecure: true` |

### Upgrade and rollback

```bash
# Upgrade (same chart, new values/image tags)
helm upgrade urumi charts/platform -n platform -f values-prod.yaml

# Roll back to the previous revision
helm history urumi -n platform
helm rollback urumi <revision> -n platform
```

The bootstrap Job is a `post-install,post-upgrade` hook with `before-hook-creation`, so it is
re-run idempotently on upgrades and does not hit Job immutability errors.

## Design and security notes

- `docs/design.md`: architecture, aggregation, routing, collisions, failure handling, and the
  local-to-production story.
- `docs/threat-model.md`: shared upstream credentials, why client tokens are not passed
  through, untrusted upstream tool descriptions, and member-to-member boundaries.

Key implementation points:

- Upstream credentials are AES-256-GCM encrypted at rest in PostgreSQL and decrypted only in
  the gateway process when opening an upstream connection. They are never returned by the API
  and never sent to browsers or MCP clients.
- Client API keys are `gw_<id>_<random>`; only a SHA-256 hash and display prefixes are stored.
  Revocation is immediate.
- Upstream tool discovery is cached briefly, refreshed in parallel, and bounded by timeouts.
  A dead or slow upstream cannot block listing or calls to other servers.
- The gateway's own MCP endpoint is stateless, so upstream calls are routed per request and the
  gateway can be scaled horizontally later.
- The WooCommerce MCP server is a ClusterIP Service with no Ingress. NetworkPolicies allow
  ingress only from gateway pods and egress only to WordPress.

## How the WooCommerce MCP server talks to the store

It uses the WooCommerce REST API (`/wp-json/wc/v3`) with a consumer key/secret generated at
install time. REST was chosen over WP-CLI because it returns structured JSON, has a stable
contract, and does not require shelling into WordPress on every tool call. Because the MCP
server talks to WordPress over plain HTTP inside the cluster and WooCommerce only enables
basic auth for SSL requests, the client signs every request with OAuth 1.0a one-legged
authentication (HMAC-SHA256). The consumer secret is never sent on the wire. The key/secret
live in a Kubernetes Secret and are injected into the MCP pod as environment variables; they
are never exposed outside the cluster.

## Troubleshooting

- **Bootstrap Job logs**: `kubectl -n store logs job/woocommerce-bootstrap`
- **Gateway logs**: `kubectl -n platform logs deploy/gateway`
- **WooCommerce REST check from inside the cluster**:
  `kubectl -n store run curl --rm -it --image=curlimages/curl -- sh` then call the store with
  the consumer key from the Secret.
- **Storefront 502 while WordPress starts**: wait for the WordPress readiness probe; the first
  install downloads WooCommerce and can take a few minutes.
- **Chat returns "Chat is not configured"**: `LLM_API_KEY` was empty at install time. Set it and
  `helm upgrade` (the secret preserves a previously provided key when values are empty).
- **Chat model does not call tools**: use a tool-capable model. Override
  `gateway.llm.model` in values or `--set gateway.llm.model=...`.
- **MCP client sees no tools**: confirm at least one server is `connected` in the dashboard and
  that the key is not revoked.
- **DeepWiki shows `unreachable`**: it is a public server; some networks block it. The
  in-cluster WooCommerce, Fulfillment and Analytics servers keep working. Remove or disable it
  from the dashboard if you do not want it listed.

## Bonus and stand-out items

The mandatory core is implemented. The multi-store provisioning bonus is not attempted.

Stand-out items that are partially implemented and where to find them:

- **Security hardening (item 6)**: upstream credentials are AES-256-GCM encrypted at rest
  (`apps/gateway/src/crypto.ts`), URLs are checked against metadata endpoints with an optional
  private-range block (`apps/gateway/src/upstream.ts`, `ALLOW_PRIVATE_UPSTREAMS`), the store
  namespace uses deny-by-default NetworkPolicies (`charts/platform/templates/networkpolicies.yaml`),
  and the Node workloads run non-root with read-only root filesystems.
- **Scaling groundwork (item 7, groundwork only)**: the gateway MCP endpoint is stateless and
  keys are authenticated per request, so multiple gateway replicas can share the PostgreSQL
  state. Per-user rate limiting and a multi-replica demo are not implemented.
- **Observability (item 8, partial)**: per-server health (`connected`/`unreachable`/`disabled`)
  with error reasons and per-call audit duration/outcome in the dashboard. Prometheus metrics
  are not implemented.
- **Production-like VPS deployment (item 1, prepared)**: same charts with `values-prod.yaml`,
  TLS values and `scripts/vps-setup.sh`. It still needs a real VPS and DNS to be demonstrated.

## Submission

The mandatory core is implemented and verified end to end on local kind. Deliverables:

| Requirement | Where |
|---|---|
| README: local setup, VPS setup, placing an order, connecting an MCP client, using the chat agent | this file |
| Source: dashboard, gateway/backend, WooCommerce MCP server, chat agent | `apps/` |
| Helm charts plus local and production values | `charts/`, `values-local.yaml`, `values-prod.yaml` |
| System design and tradeoffs note | `docs/design.md` |
| Threat model note | `docs/threat-model.md` |
| Bonus and stand-out items, and where to find them | "Bonus and stand-out items" above |

The demo video walks the definition of done with two users and covers the required demo
sections (Kubernetes, MCP internals, security posture, chat agent, local-to-VPS story), and is
submitted with this repository via <https://forms.gle/nftwgyNeenSDmiRb6>.
