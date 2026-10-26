import type { Pool } from "pg";
import { insertAudit } from "./repo.js";

export interface ToolAuditEntry {
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
}

export async function recordToolCall(pool: Pool, entry: ToolAuditEntry): Promise<void> {
  try {
    await insertAudit(pool, entry);
  } catch (error) {
    console.error("Failed to write audit log entry", error);
  }
}
