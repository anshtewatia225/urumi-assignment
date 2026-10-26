import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { requireSession } from "../auth.js";
import { generateApiKey } from "../crypto.js";
import { uuidParam } from "../params.js";
import {
  createApiKey,
  findApiKeyById,
  findUserById,
  listApiKeysByUser,
  revokeApiKey,
  type ApiKeyRow,
} from "../repo.js";

export function publicKey(key: ApiKeyRow) {
  return {
    id: key.id,
    userId: key.user_id,
    name: key.name,
    prefix: key.prefix,
    last4: key.last4,
    createdAt: key.created_at,
    lastUsedAt: key.last_used_at,
    revokedAt: key.revoked_at,
  };
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  userId: z.string().uuid().optional(),
});

export function keysRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireSession);

  router.get("/", async (req, res, next) => {
    try {
      const user = req.user!;
      const requestedUserId = typeof req.query.userId === "string" ? req.query.userId : undefined;
      if (requestedUserId && requestedUserId !== user.id && user.role !== "admin") {
        res.status(403).json({ error: "Only admins can list other users' keys" });
        return;
      }
      const targetUserId = requestedUserId ?? user.id;
      const targetUser = await findUserById(pool, targetUserId);
      if (!targetUser) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const keys = await listApiKeysByUser(pool, targetUserId);
      res.json({ keys: keys.map(publicKey) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const user = req.user!;
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "A key name is required" });
        return;
      }
      const targetUserId = parsed.data.userId ?? user.id;
      if (targetUserId !== user.id && user.role !== "admin") {
        res.status(403).json({ error: "Only admins can issue keys for other users" });
        return;
      }
      const targetUser = await findUserById(pool, targetUserId);
      if (!targetUser) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const generated = generateApiKey();
      const key = await createApiKey(pool, {
        id: randomUUID(),
        userId: targetUserId,
        name: parsed.data.name,
        prefix: generated.prefix,
        last4: generated.last4,
        keyHash: generated.hash,
      });
      res.status(201).json({ key: publicKey(key), plaintext: generated.plaintext });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const user = req.user!;
      const keyId = uuidParam(req.params.id);
      if (!keyId) {
        res.status(400).json({ error: "Invalid key id" });
        return;
      }
      const key = await findApiKeyById(pool, keyId);
      if (!key) {
        res.status(404).json({ error: "Key not found" });
        return;
      }
      if (key.user_id !== user.id && user.role !== "admin") {
        res.status(403).json({ error: "Only admins can revoke other users' keys" });
        return;
      }
      const revoked = await revokeApiKey(pool, key.id);
      res.json({ key: revoked ? publicKey(revoked) : publicKey(key) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
