import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { findUserByEmail } from "../repo.js";
import { verifyPassword } from "../crypto.js";
import {
  clearSessionCookie,
  requireSession,
  setSessionCookie,
  signSession,
  toSessionUser,
} from "../auth.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function authRouter(pool: Pool): Router {
  const router = Router();

  router.post("/login", async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "A valid email and password are required" });
        return;
      }
      const user = await findUserByEmail(pool, parsed.data.email);
      if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
        res.status(401).json({ error: "Invalid email or password" });
        return;
      }
      const sessionUser = toSessionUser(user);
      setSessionCookie(res, signSession(sessionUser));
      res.json({ user: sessionUser });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get("/me", requireSession, (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
