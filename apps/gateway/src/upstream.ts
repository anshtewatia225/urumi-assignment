import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Pool } from "pg";
import { SecretBox } from "./crypto.js";
import { findServerById, listServers, type UpstreamServerRow } from "./repo.js";

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type ServerHealth = "connected" | "unreachable" | "disabled";

export interface ServerStatus {
  id: string;
  name: string;
  slug: string;
  url: string;
  enabled: boolean;
  authType: UpstreamServerRow["auth_type"];
  headerName: string | null;
  status: ServerHealth;
  error: string | null;
  tools: UpstreamTool[];
  exposedTools: string[];
}

export interface AggregatedTool extends UpstreamTool {
  serverId: string;
  serverSlug: string;
  serverName: string;
  exposedName: string;
}

export interface CallToolResultLike {
  content: unknown[];
  isError?: boolean;
}

interface CacheEntry {
  tools: UpstreamTool[];
  fetchedAt: number;
  error: string | null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function assertSafeUpstreamUrl(rawUrl: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Upstream URL is not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Upstream URL must use http or https");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "169.254.169.254" ||
    hostname === "metadata.google.internal" ||
    hostname === "metadata" ||
    hostname === "0.0.0.0"
  ) {
    throw new Error("Upstream URL points at a blocked metadata/loopback address");
  }
  if (!allowPrivate && (hostname === "localhost" || hostname === "::1" || isPrivateIpv4(hostname))) {
    throw new Error("Upstream URL points at a private address and private upstreams are disabled");
  }
  return url;
}

export class UpstreamManager {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly pool: Pool,
    private readonly secretBox: SecretBox,
    private readonly options: {
      listTimeoutMs: number;
      callTimeoutMs: number;
      cacheTtlMs: number;
      allowPrivateUpstreams: boolean;
    },
  ) {}

  invalidate(serverId?: string): void {
    if (serverId) {
      this.cache.delete(serverId);
      this.inflight.delete(serverId);
    } else {
      this.cache.clear();
      this.inflight.clear();
    }
  }

  validateUrl(rawUrl: string): URL {
    return assertSafeUpstreamUrl(rawUrl, this.options.allowPrivateUpstreams);
  }

  private authHeaders(row: UpstreamServerRow): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": "urumi-mcp-gateway/0.1.0",
    };
    if (row.auth_type !== "none" && row.auth_secret) {
      const secret = this.secretBox.decrypt(row.auth_secret);
      if (row.auth_type === "bearer") {
        headers.Authorization = `Bearer ${secret}`;
      } else if (row.auth_type === "header" && row.auth_header_name) {
        headers[row.auth_header_name] = secret;
      }
    }
    return headers;
  }

  private createClient(row: UpstreamServerRow): {
    client: Client;
    transport: StreamableHTTPClientTransport;
  } {
    assertSafeUpstreamUrl(row.url, this.options.allowPrivateUpstreams);
    const transport = new StreamableHTTPClientTransport(new URL(row.url), {
      requestInit: { headers: this.authHeaders(row) },
    });
    const client = new Client({ name: "urumi-gateway", version: "0.1.0" }, { capabilities: {} });
    return { client, transport };
  }

  async fetchTools(row: UpstreamServerRow): Promise<UpstreamTool[]> {
    const { client, transport } = this.createClient(row);
    try {
      await withTimeout(client.connect(transport), this.options.listTimeoutMs, `${row.slug} connect`);
      const result = await withTimeout(client.listTools(), this.options.listTimeoutMs, `${row.slug} tools/list`);
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      }));
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  private refreshOne(row: UpstreamServerRow): Promise<void> {
    const existing = this.inflight.get(row.id);
    if (existing) return existing;
    const task = (async () => {
      try {
        const tools = await this.fetchTools(row);
        this.cache.set(row.id, { tools, fetchedAt: Date.now(), error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.cache.set(row.id, { tools: [], fetchedAt: Date.now(), error: message });
      } finally {
        this.inflight.delete(row.id);
      }
    })();
    this.inflight.set(row.id, task);
    return task;
  }

  private toStatus(row: UpstreamServerRow): ServerStatus {
    if (!row.enabled) {
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        url: row.url,
        enabled: false,
        authType: row.auth_type,
        headerName: row.auth_header_name,
        status: "disabled",
        error: null,
        tools: [],
        exposedTools: [],
      };
    }
    const entry = this.cache.get(row.id);
    const status: ServerHealth = entry && !entry.error ? "connected" : "unreachable";
    const tools = entry && !entry.error ? entry.tools : [];
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      url: row.url,
      enabled: true,
      authType: row.auth_type,
      headerName: row.auth_header_name,
      status,
      error: entry?.error ?? null,
      tools,
      exposedTools: tools.map((tool) => `${row.slug}__${tool.name}`),
    };
  }

  async statuses(): Promise<ServerStatus[]> {
    const rows = await listServers(this.pool);
    const now = Date.now();
    await Promise.all(
      rows
        .filter((row) => row.enabled)
        .filter((row) => {
          const entry = this.cache.get(row.id);
          return !entry || now - entry.fetchedAt >= this.options.cacheTtlMs;
        })
        .map((row) => this.refreshOne(row)),
    );
    return rows.map((row) => this.toStatus(row));
  }

  async aggregate(): Promise<{ tools: AggregatedTool[]; servers: ServerStatus[] }> {
    const servers = await this.statuses();
    const tools: AggregatedTool[] = [];
    for (const server of servers) {
      if (server.status !== "connected") continue;
      for (const tool of server.tools) {
        tools.push({
          ...tool,
          serverId: server.id,
          serverSlug: server.slug,
          serverName: server.name,
          exposedName: `${server.slug}__${tool.name}`,
        });
      }
    }
    return { tools, servers };
  }

  async callToolById(serverId: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResultLike> {
    const row = await findServerById(this.pool, serverId);
    if (!row) {
      throw new Error("Upstream server no longer exists");
    }
    if (!row.enabled) {
      throw new Error(`Upstream server ${row.name} is disabled`);
    }
    const { client, transport } = this.createClient(row);
    try {
      await withTimeout(client.connect(transport), this.options.listTimeoutMs, `${row.slug} connect`);
      const result = await withTimeout(
        client.callTool({ name: toolName, arguments: args }),
        this.options.callTimeoutMs,
        `${row.slug} tools/call ${toolName}`,
      );
      return {
        content: Array.isArray(result.content) ? (result.content as unknown[]) : [],
        isError: typeof result.isError === "boolean" ? result.isError : undefined,
      };
    } finally {
      await transport.close().catch(() => undefined);
    }
  }
}
