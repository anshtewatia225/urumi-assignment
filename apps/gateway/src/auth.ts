import jwt from "jsonwebtoken";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { env } from "./env.js";
import { sha256 } from "./crypto.js";
import { findApiKeyByHash, findUserById, touchApiKey, type Role, type UserRow } from "./repo.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export function toSessionUser(user: UserRow): SessionUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

export function signSession(user: SessionUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    env.sessionSecret,
    { expiresIn: env.sessionTtlHours * 3600 },
  );
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(env.sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookieSecure,
    maxAge: env.sessionTtlHours * 3600 * 1000,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(env.sessionCookieName, { path: "/" });
}

export function sessionMiddleware(pool: Pool): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[env.sessionCookieName];
    if (typeof token === "string" && token) {
      try {
        const payload = jwt.verify(token, env.sessionSecret) as jwt.JwtPayload;
        if (typeof payload.sub === "string") {
          // Re-read the user so role changes and deletions take effect immediately.
          const user = await findUserById(pool, payload.sub);
          if (user) {
            req.user = toSessionUser(user);
          }
        }
      } catch {
        // Invalid or expired cookie: treat as unauthenticated.
      }
    }
    next();
  };
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin role required" });
    return;
  }
  next();
}

function rpcAuthError(res: Response, message: string): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message },
    id: null,
  });
}

export function authenticateApiKey(pool: Pool): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      let token: string | undefined;
      if (typeof header === "string" && header.startsWith("Bearer ")) {
        token = header.slice("Bearer ".length).trim();
      } else if (typeof req.headers["x-api-key"] === "string") {
        token = req.headers["x-api-key"];
      }

      if (!token) {
        rpcAuthError(res, "Missing gateway API key");
        return;
      }

      const key = await findApiKeyByHash(pool, sha256(token));
      if (!key || key.revoked_at) {
        rpcAuthError(res, "Invalid or revoked gateway API key");
        return;
      }

      const user = await findUserById(pool, key.user_id);
      if (!user) {
        rpcAuthError(res, "API key owner no longer exists");
        return;
      }

      req.user = toSessionUser(user);
      req.apiKeyId = key.id;
      await touchApiKey(pool, key.id);
      next();
    } catch (error) {
      next(error);
    }
  };
}
