export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  createdAt?: string;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ServerStatus {
  id: string;
  name: string;
  slug: string;
  url: string;
  enabled: boolean;
  authType: "none" | "bearer" | "header";
  headerName: string | null;
  status: "connected" | "unreachable" | "disabled";
  error: string | null;
  tools: ToolInfo[];
  exposedTools: string[];
}

export interface ApiKeyInfo {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AuditEntry {
  id: string;
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
  createdAt: string;
}
