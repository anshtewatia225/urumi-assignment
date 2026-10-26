import type { Pool } from "pg";

export type Role = "admin" | "member";
export type AuthType = "none" | "bearer" | "header";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  created_at: Date;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  last4: string;
  key_hash: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export interface UpstreamServerRow {
  id: string;
  name: string;
  slug: string;
  url: string;
  auth_type: AuthType;
  auth_header_name: string | null;
  auth_secret: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AuditRow {
  id: string;
  user_id: string | null;
  user_email: string | null;
  server_slug: string | null;
  server_name: string | null;
  tool_name: string | null;
  exposed_tool_name: string | null;
  source: "mcp" | "chat";
  success: boolean;
  duration_ms: number;
  error: string | null;
  created_at: Date;
}

export async function findUserByEmail(pool: Pool, email: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>("select * from users where lower(email) = lower($1)", [email]);
  return result.rows[0] ?? null;
}

export async function findUserById(pool: Pool, id: string): Promise<UserRow | null> {
  const result = await pool.query<UserRow>("select * from users where id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function listUsers(pool: Pool): Promise<UserRow[]> {
  const result = await pool.query<UserRow>("select * from users order by created_at asc");
  return result.rows;
}

export async function createUser(
  pool: Pool,
  user: { id: string; email: string; name: string; role: Role; passwordHash: string },
): Promise<UserRow> {
  const result = await pool.query<UserRow>(
    `insert into users (id, email, name, role, password_hash)
     values ($1, $2, $3, $4, $5) returning *`,
    [user.id, user.email, user.name, user.role, user.passwordHash],
  );
  return result.rows[0];
}

export async function updateUserRole(pool: Pool, id: string, role: Role): Promise<UserRow | null> {
  const result = await pool.query<UserRow>("update users set role = $2 where id = $1 returning *", [id, role]);
  return result.rows[0] ?? null;
}

export async function countAdmins(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>("select count(*)::text as count from users where role = 'admin'");
  return Number(result.rows[0]?.count ?? 0);
}

export async function deleteUser(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query("delete from users where id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function createApiKey(
  pool: Pool,
  key: { id: string; userId: string; name: string; prefix: string; last4: string; keyHash: string },
): Promise<ApiKeyRow> {
  const result = await pool.query<ApiKeyRow>(
    `insert into api_keys (id, user_id, name, prefix, last4, key_hash)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [key.id, key.userId, key.name, key.prefix, key.last4, key.keyHash],
  );
  return result.rows[0];
}

export async function listApiKeysByUser(pool: Pool, userId: string): Promise<ApiKeyRow[]> {
  const result = await pool.query<ApiKeyRow>(
    "select * from api_keys where user_id = $1 order by created_at desc",
    [userId],
  );
  return result.rows;
}

export async function findApiKeyById(pool: Pool, id: string): Promise<ApiKeyRow | null> {
  const result = await pool.query<ApiKeyRow>("select * from api_keys where id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function findApiKeyByHash(pool: Pool, keyHash: string): Promise<ApiKeyRow | null> {
  const result = await pool.query<ApiKeyRow>("select * from api_keys where key_hash = $1", [keyHash]);
  return result.rows[0] ?? null;
}

export async function revokeApiKey(pool: Pool, id: string): Promise<ApiKeyRow | null> {
  const result = await pool.query<ApiKeyRow>(
    "update api_keys set revoked_at = now() where id = $1 and revoked_at is null returning *",
    [id],
  );
  return result.rows[0] ?? null;
}

export async function touchApiKey(pool: Pool, id: string): Promise<void> {
  await pool.query("update api_keys set last_used_at = now() where id = $1", [id]);
}

export async function listServers(pool: Pool): Promise<UpstreamServerRow[]> {
  const result = await pool.query<UpstreamServerRow>("select * from upstream_servers order by created_at asc");
  return result.rows;
}

export async function findServerById(pool: Pool, id: string): Promise<UpstreamServerRow | null> {
  const result = await pool.query<UpstreamServerRow>("select * from upstream_servers where id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function findServerBySlug(pool: Pool, slug: string): Promise<UpstreamServerRow | null> {
  const result = await pool.query<UpstreamServerRow>("select * from upstream_servers where slug = $1", [slug]);
  return result.rows[0] ?? null;
}

export async function createServer(
  pool: Pool,
  server: {
    id: string;
    name: string;
    slug: string;
    url: string;
    authType: AuthType;
    headerName: string | null;
    secretEncrypted: string | null;
    enabled: boolean;
  },
): Promise<UpstreamServerRow> {
  const result = await pool.query<UpstreamServerRow>(
    `insert into upstream_servers (id, name, slug, url, auth_type, auth_header_name, auth_secret, enabled)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [server.id, server.name, server.slug, server.url, server.authType, server.headerName, server.secretEncrypted, server.enabled],
  );
  return result.rows[0];
}

export async function replaceServer(
  pool: Pool,
  server: UpstreamServerRow,
): Promise<UpstreamServerRow> {
  const result = await pool.query<UpstreamServerRow>(
    `update upstream_servers
       set name = $2, slug = $3, url = $4, auth_type = $5, auth_header_name = $6,
           auth_secret = $7, enabled = $8, updated_at = now()
     where id = $1 returning *`,
    [server.id, server.name, server.slug, server.url, server.auth_type, server.auth_header_name, server.auth_secret, server.enabled],
  );
  return result.rows[0];
}

export async function deleteServer(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query("delete from upstream_servers where id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function insertSeedServer(
  pool: Pool,
  server: {
    id: string;
    name: string;
    slug: string;
    url: string;
    authType: AuthType;
    headerName: string | null;
    secretEncrypted: string | null;
    enabled: boolean;
  },
): Promise<void> {
  await pool.query(
    `insert into upstream_servers (id, name, slug, url, auth_type, auth_header_name, auth_secret, enabled)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (slug) do nothing`,
    [server.id, server.name, server.slug, server.url, server.authType, server.headerName, server.secretEncrypted, server.enabled],
  );
}

export async function insertAudit(
  pool: Pool,
  entry: {
    userId: string | null;
    userEmail: string | null;
    serverSlug: string | null;
    serverName: string | null;
    toolName: string | null;
    exposedToolName: string | null;
    source: "mcp" | "chat";
    success: boolean;
    durationMs: number;
    error: string | null;
  },
): Promise<void> {
  await pool.query(
    `insert into audit_log
       (user_id, user_email, server_slug, server_name, tool_name, exposed_tool_name, source, success, duration_ms, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.userId,
      entry.userEmail,
      entry.serverSlug,
      entry.serverName,
      entry.toolName,
      entry.exposedToolName,
      entry.source,
      entry.success,
      entry.durationMs,
      entry.error,
    ],
  );
}

export async function listAudit(
  pool: Pool,
  filters: { userId?: string; serverSlug?: string; toolName?: string; source?: string; limit?: number },
): Promise<AuditRow[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.userId) {
    values.push(filters.userId);
    clauses.push(`user_id = $${values.length}`);
  }
  if (filters.serverSlug) {
    values.push(filters.serverSlug);
    clauses.push(`server_slug = $${values.length}`);
  }
  if (filters.toolName) {
    values.push(`%${filters.toolName}%`);
    clauses.push(`exposed_tool_name ilike $${values.length}`);
  }
  if (filters.source) {
    values.push(filters.source);
    clauses.push(`source = $${values.length}`);
  }
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  values.push(limit);
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const result = await pool.query<AuditRow>(
    `select * from audit_log ${where} order by created_at desc, id desc limit $${values.length}`,
    values,
  );
  return result.rows;
}
