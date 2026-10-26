function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface SeedUpstream {
  name: string;
  slug: string;
  url: string;
  authType?: "none" | "bearer" | "header";
  headerName?: string;
  secret?: string;
  enabled?: boolean;
}

function parseSeedUpstreams(): SeedUpstream[] {
  const raw = process.env.SEED_UPSTREAMS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("SEED_UPSTREAMS must be a JSON array");
    }
    return parsed as SeedUpstream[];
  } catch (error) {
    console.error("Ignoring invalid SEED_UPSTREAMS:", error instanceof Error ? error.message : error);
    return [];
  }
}

export const env = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: required("DATABASE_URL"),
  sessionSecret: required("SESSION_SECRET"),
  credentialEncryptionKey: required("CREDENTIAL_ENCRYPTION_KEY"),
  sessionCookieName: "urumi_session",
  sessionTtlHours: numberFromEnv("SESSION_TTL_HOURS", 12),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  corsOrigin: process.env.CORS_ORIGIN ?? "",
  admin: {
    email: process.env.ADMIN_EMAIL ?? "admin@urumi.local",
    name: process.env.ADMIN_NAME ?? "Urumi Admin",
    password: required("ADMIN_PASSWORD"),
  },
  llm: {
    baseUrl: (process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    model: process.env.LLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free",
    apiKey: process.env.LLM_API_KEY ?? "",
    maxIterations: numberFromEnv("LLM_MAX_ITERATIONS", 6),
    timeoutMs: numberFromEnv("LLM_TIMEOUT_MS", 60000),
  },
  tools: {
    listTimeoutMs: numberFromEnv("TOOL_LIST_TIMEOUT_MS", 5000),
    callTimeoutMs: numberFromEnv("TOOL_CALL_TIMEOUT_MS", 30000),
    cacheTtlMs: numberFromEnv("TOOL_CACHE_TTL_MS", 15000),
  },
  allowPrivateUpstreams: process.env.ALLOW_PRIVATE_UPSTREAMS !== "false",
  seedUpstreams: parseSeedUpstreams(),
};
