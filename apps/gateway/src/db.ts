import pg from "pg";

const { Pool } = pg;

export interface PoolOptions {
  connectionTimeoutMillis?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

export function createPool(databaseUrl: string, options: PoolOptions = {}): pg.Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });
  pool.on("error", (error) => {
    console.error("Unexpected Postgres pool error", error);
  });
  return pool;
}

const SCHEMA = `
create table if not exists users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  role text not null check (role in ('admin', 'member')),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists api_keys (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  prefix text not null,
  last4 text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table if not exists upstream_servers (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  url text not null,
  auth_type text not null default 'none' check (auth_type in ('none', 'bearer', 'header')),
  auth_header_name text,
  auth_secret text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  user_id uuid references users(id) on delete set null,
  user_email text,
  server_slug text,
  server_name text,
  tool_name text,
  exposed_tool_name text,
  source text not null check (source in ('mcp', 'chat')),
  success boolean not null,
  duration_ms integer not null,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_at_idx on audit_log (created_at desc);
create index if not exists audit_log_user_id_idx on audit_log (user_id);
create index if not exists audit_log_server_slug_idx on audit_log (server_slug);
`;

export interface InitDbOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_INIT_ATTEMPTS = 60;
const DEFAULT_INIT_DELAY_MS = 500;
const DEFAULT_INIT_MAX_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function initDb(pool: pg.Pool, options: InitDbOptions = {}): Promise<void> {
  const attempts = options.attempts ?? DEFAULT_INIT_ATTEMPTS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_INIT_MAX_DELAY_MS;
  let delayMs = Math.min(options.initialDelayMs ?? DEFAULT_INIT_DELAY_MS, maxDelayMs);

  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA);
      if (attempt > 1) {
        console.log(`Database schema ready after ${attempt} attempt(s)`);
      }
      return;
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      console.error(
        `Database not reachable (attempt ${attempt}/${attempts}): ${describeError(error)}; retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}
