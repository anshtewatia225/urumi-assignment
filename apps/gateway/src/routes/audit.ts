import { Router } from "express";
import type { Pool } from "pg";
import { requireSession } from "../auth.js";
import { listAudit, type AuditRow } from "../repo.js";

function publicAuditEntry(row: AuditRow) {
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email,
    serverSlug: row.server_slug,
    serverName: row.server_name,
    toolName: row.tool_name,
    exposedToolName: row.exposed_tool_name,
    source: row.source,
    success: row.success,
    durationMs: row.duration_ms,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function auditRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireSession);

  router.get("/", async (req, res, next) => {
    try {
      const user = req.user!;
      const limitRaw = Number(req.query.limit ?? 100);
      const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
      const userId =
        user.role === "admin"
          ? typeof req.query.userId === "string"
            ? req.query.userId
            : undefined
          : user.id;
      const entries = await listAudit(pool, {
        userId,
        serverSlug: typeof req.query.serverSlug === "string" ? req.query.serverSlug : undefined,
        toolName: typeof req.query.tool === "string" ? req.query.tool : undefined,
        source: typeof req.query.source === "string" ? req.query.source : undefined,
        limit,
      });
      res.json({ entries: entries.map(publicAuditEntry) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
