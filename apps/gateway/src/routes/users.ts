import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { requireAdmin } from "../auth.js";
import { generatePassword, hashPassword } from "../crypto.js";
import { uuidParam } from "../params.js";
import {
  countAdmins,
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  listUsers,
  updateUserRole,
  type Role,
  type UserRow,
} from "../repo.js";

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.created_at,
  };
}

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(["admin", "member"]).default("member"),
  password: z.string().min(8).max(200).optional(),
});

const roleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

export function usersRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get("/", async (_req, res, next) => {
    try {
      const users = await listUsers(pool);
      res.json({ users: users.map(publicUser) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid user payload", details: parsed.error.flatten() });
        return;
      }
      const body = parsed.data;
      const existing = await findUserByEmail(pool, body.email);
      if (existing) {
        res.status(409).json({ error: "A user with that email already exists" });
        return;
      }
      const temporaryPassword = body.password ?? generatePassword();
      const user = await createUser(pool, {
        id: randomUUID(),
        email: body.email,
        name: body.name,
        role: body.role as Role,
        passwordHash: hashPassword(temporaryPassword),
      });
      res.status(201).json({
        user: publicUser(user),
        temporaryPassword: body.password ? undefined : temporaryPassword,
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      const parsed = roleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "role must be admin or member" });
        return;
      }
      const userId = uuidParam(req.params.id);
      if (!userId) {
        res.status(400).json({ error: "Invalid user id" });
        return;
      }
      const user = await findUserById(pool, userId);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      if (user.role === "admin" && parsed.data.role === "member") {
        const admins = await countAdmins(pool);
        if (admins <= 1) {
          res.status(400).json({ error: "Cannot demote the last remaining admin" });
          return;
        }
      }
      const updated = await updateUserRole(pool, user.id, parsed.data.role as Role);
      res.json({ user: updated ? publicUser(updated) : null });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const userId = uuidParam(req.params.id);
      if (!userId) {
        res.status(400).json({ error: "Invalid user id" });
        return;
      }
      const user = await findUserById(pool, userId);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      if (user.role === "admin") {
        const admins = await countAdmins(pool);
        if (admins <= 1) {
          res.status(400).json({ error: "Cannot delete the last remaining admin" });
          return;
        }
      }
      await deleteUser(pool, user.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
