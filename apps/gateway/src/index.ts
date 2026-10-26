import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { env } from "./env.js";
import { createPool, initDb } from "./db.js";
import { SecretBox, hashPassword } from "./crypto.js";
import { createUser, findUserByEmail, insertSeedServer } from "./repo.js";
import { sessionMiddleware } from "./auth.js";
import { UpstreamManager } from "./upstream.js";
import { authRouter } from "./routes/auth.js";
import { serversRouter } from "./routes/servers.js";
import { usersRouter } from "./routes/users.js";
import { keysRouter } from "./routes/keys.js";
import { auditRouter } from "./routes/audit.js";
import { chatRouter } from "./routes/chat.js";
import { mcpEndpointRouter } from "./mcpEndpoint.js";

async function bootstrapAdmin(pool: ReturnType<typeof createPool>): Promise<void> {
  const existing = await findUserByEmail(pool, env.admin.email);
  if (existing) return;
  await createUser(pool, {
    id: randomUUID(),
    email: env.admin.email.toLowerCase(),
    name: env.admin.name,
    role: "admin",
    passwordHash: hashPassword(env.admin.password),
  });
  console.log(`Bootstrapped admin account ${env.admin.email}`);
}

async function seedUpstreams(pool: ReturnType<typeof createPool>, secretBox: SecretBox): Promise<void> {
  for (const seed of env.seedUpstreams) {
    await insertSeedServer(pool, {
      id: randomUUID(),
      name: seed.name,
      slug: seed.slug,
      url: seed.url,
      authType: seed.authType ?? "none",
      headerName: seed.headerName ?? null,
      secretEncrypted: seed.secret ? secretBox.encrypt(seed.secret) : null,
      enabled: seed.enabled ?? true,
    });
  }
  if (env.seedUpstreams.length > 0) {
    console.log(`Seeded ${env.seedUpstreams.length} upstream server definition(s)`);
  }
}

async function main(): Promise<void> {
  const pool = createPool(env.databaseUrl);
  const secretBox = new SecretBox(env.credentialEncryptionKey);
  const manager = new UpstreamManager(pool, secretBox, {
    listTimeoutMs: env.tools.listTimeoutMs,
    callTimeoutMs: env.tools.callTimeoutMs,
    cacheTtlMs: env.tools.cacheTtlMs,
    allowPrivateUpstreams: env.allowPrivateUpstreams,
  });

  await initDb(pool);
  await bootstrapAdmin(pool);
  await seedUpstreams(pool, secretBox);

  const app = express();
  app.disable("x-powered-by");
  if (env.corsOrigin) {
    app.use(
      cors({
        origin: env.corsOrigin.split(",").map((origin) => origin.trim()),
        credentials: true,
      }),
    );
  }
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use(sessionMiddleware(pool));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "urumi-gateway" });
  });

  app.get("/readyz", async (_req, res) => {
    try {
      await pool.query("select 1");
      res.json({ status: "ready", database: "ok" });
    } catch {
      res.status(503).json({ status: "not-ready", database: "unavailable" });
    }
  });

  app.use("/api/auth", authRouter(pool));
  app.use("/api/servers", serversRouter(pool, manager, secretBox));
  app.use("/api/users", usersRouter(pool));
  app.use("/api/keys", keysRouter(pool));
  app.use("/api/audit", auditRouter(pool));
  app.use("/api/chat", chatRouter(pool, manager));
  app.use(mcpEndpointRouter(pool, manager));

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    console.error("Unhandled request error", error);
    res.status(500).json({ error: "Internal server error" });
  });

  const server = app.listen(env.port, () => {
    console.log(`urumi-gateway listening on port ${env.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Failed to start gateway", error);
  process.exit(1);
});
