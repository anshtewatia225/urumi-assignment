import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { requireAdmin } from "../auth.js";
import { SecretBox } from "../crypto.js";
import { uuidParam } from "../params.js";
import {
  createServer,
  deleteServer,
  findServerById,
  findServerBySlug,
  replaceServer,
  type AuthType,
  type UpstreamServerRow,
} from "../repo.js";
import { type UpstreamManager } from "../upstream.js";

const authTypeSchema = z.enum(["none", "bearer", "header"]);

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(40).optional(),
  url: z.string().url(),
  authType: authTypeSchema.default("none"),
  headerName: z.string().trim().min(1).max(80).optional(),
  secret: z.string().max(8192).optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  slug: z.string().trim().min(1).max(40).optional(),
  url: z.string().url().optional(),
  authType: authTypeSchema.optional(),
  headerName: z.string().trim().min(1).max(80).nullable().optional(),
  secret: z.string().max(8192).nullable().optional(),
  enabled: z.boolean().optional(),
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return base || "server";
}

async function uniqueSlug(pool: Pool, requested: string, excludeId?: string): Promise<string> {
  let candidate = requested;
  let suffix = 2;
  for (;;) {
    const existing = await findServerBySlug(pool, candidate);
    if (!existing || existing.id === excludeId) {
      return candidate;
    }
    candidate = `${requested}_${suffix++}`;
  }
}

function validateAuthConfig(authType: AuthType, headerName: string | null): string | null {
  if (authType === "header" && !headerName) {
    return "headerName is required when authType is header";
  }
  return null;
}

export function serversRouter(pool: Pool, manager: UpstreamManager, secretBox: SecretBox): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get("/", async (req, res, next) => {
    try {
      if (req.query.refresh === "1") {
        manager.invalidate();
      }
      const servers = await manager.statuses();
      res.json({ servers });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid server payload", details: parsed.error.flatten() });
        return;
      }
      const body = parsed.data;
      manager.validateUrl(body.url);
      const authError = validateAuthConfig(body.authType, body.headerName ?? null);
      if (authError) {
        res.status(400).json({ error: authError });
        return;
      }

      const slug = await uniqueSlug(pool, body.slug ? slugify(body.slug) : slugify(body.name));
      const server = await createServer(pool, {
        id: randomUUID(),
        name: body.name,
        slug,
        url: body.url,
        authType: body.authType,
        headerName: body.authType === "header" ? body.headerName ?? null : null,
        secretEncrypted: body.secret ? secretBox.encrypt(body.secret) : null,
        enabled: body.enabled ?? true,
      });
      manager.invalidate(server.id);
      const statuses = await manager.statuses();
      res.status(201).json({ server: statuses.find((item) => item.id === server.id) ?? null });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const serverId = uuidParam(req.params.id);
      if (!serverId) {
        res.status(400).json({ error: "Invalid server id" });
        return;
      }
      const existing = await findServerById(pool, serverId);
      if (!existing) {
        res.status(404).json({ error: "Server not found" });
        return;
      }
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid server payload", details: parsed.error.flatten() });
        return;
      }
      const body = parsed.data;
      const authType: AuthType = body.authType ?? existing.auth_type;
      const headerName =
        body.headerName !== undefined
          ? body.headerName
          : authType === existing.auth_type
            ? existing.auth_header_name
            : null;

      manager.validateUrl(body.url ?? existing.url);
      const authError = validateAuthConfig(authType, headerName);
      if (authError) {
        res.status(400).json({ error: authError });
        return;
      }

      let slug = existing.slug;
      if (body.slug) {
        slug = await uniqueSlug(pool, slugify(body.slug), existing.id);
      } else if (body.name) {
        // Keep the existing slug stable unless the admin explicitly sends one.
        slug = existing.slug;
      }

      let secretEncrypted = existing.auth_secret;
      if (body.secret !== undefined) {
        secretEncrypted = body.secret ? secretBox.encrypt(body.secret) : null;
      }
      if (authType === "none") {
        secretEncrypted = null;
      }

      const updated: UpstreamServerRow = {
        ...existing,
        name: body.name ?? existing.name,
        slug,
        url: body.url ?? existing.url,
        auth_type: authType,
        auth_header_name: authType === "header" ? headerName : null,
        auth_secret: secretEncrypted,
        enabled: body.enabled ?? existing.enabled,
      };
      const saved = await replaceServer(pool, updated);
      manager.invalidate(saved.id);
      const statuses = await manager.statuses();
      res.json({ server: statuses.find((item) => item.id === saved.id) ?? null });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/refresh", async (req, res, next) => {
    try {
      const serverId = uuidParam(req.params.id);
      if (!serverId) {
        res.status(400).json({ error: "Invalid server id" });
        return;
      }
      const existing = await findServerById(pool, serverId);
      if (!existing) {
        res.status(404).json({ error: "Server not found" });
        return;
      }
      manager.invalidate(existing.id);
      const statuses = await manager.statuses();
      res.json({ server: statuses.find((item) => item.id === existing.id) ?? null });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const serverId = uuidParam(req.params.id);
      if (!serverId) {
        res.status(400).json({ error: "Invalid server id" });
        return;
      }
      const existing = await findServerById(pool, serverId);
      if (!existing) {
        res.status(404).json({ error: "Server not found" });
        return;
      }
      await deleteServer(pool, existing.id);
      manager.invalidate(existing.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

