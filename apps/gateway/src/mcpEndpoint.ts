import { Router } from "express";
import type { Pool } from "pg";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { authenticateApiKey } from "./auth.js";
import { recordToolCall } from "./audit.js";
import type { AggregatedTool, UpstreamManager } from "./upstream.js";

export const META_TOOL_LIST_SERVERS = "gateway__list_servers";

function summarizeContent(content: unknown[]): string | null {
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block) {
      return String((block as Record<string, unknown>).text).slice(0, 2000);
    }
  }
  return null;
}

export function mcpEndpointRouter(pool: Pool, manager: UpstreamManager): Router {
  const router = Router();

  router.post("/mcp", authenticateApiKey(pool), async (req, res) => {
    try {
      const { tools, servers } = await manager.aggregate();
      const byExposedName = new Map<string, AggregatedTool>();
      for (const tool of tools) {
        byExposedName.set(tool.exposedName, tool);
      }

      const server = new Server(
        { name: "urumi-gateway", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          ...tools.map((tool) => ({
            name: tool.exposedName,
            description: `[${tool.serverName}] ${tool.description ?? tool.name}`,
            inputSchema: tool.inputSchema,
          })),
          {
            name: META_TOOL_LIST_SERVERS,
            description:
              "List the upstream MCP servers known to this gateway, with their connection status and exposed tool names.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }));

      server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
        const user = req.user!;

        if (request.params.name === META_TOOL_LIST_SERVERS) {
          const summaries = servers.map((status) => ({
            name: status.name,
            slug: status.slug,
            status: status.status,
            enabled: status.enabled,
            toolCount: status.tools.length,
            exposedTools: status.exposedTools,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(summaries, null, 2) }],
          };
        }

        const tool = byExposedName.get(request.params.name);
        if (!tool) {
          const [slug, rawTool] = request.params.name.split("__");
          await recordToolCall(pool, {
            userId: user.id,
            userEmail: user.email,
            serverSlug: slug ?? null,
            serverName: null,
            toolName: rawTool ?? request.params.name,
            exposedToolName: request.params.name,
            source: "mcp",
            success: false,
            durationMs: 0,
            error: "Tool is not available (server disabled, removed, or unknown)",
          });
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool ${request.params.name}`);
        }

        const startedAt = Date.now();
        try {
          const result = await manager.callToolById(
            tool.serverId,
            tool.name,
            (request.params.arguments ?? {}) as Record<string, unknown>,
          );
          await recordToolCall(pool, {
            userId: user.id,
            userEmail: user.email,
            serverSlug: tool.serverSlug,
            serverName: tool.serverName,
            toolName: tool.name,
            exposedToolName: tool.exposedName,
            source: "mcp",
            success: !result.isError,
            durationMs: Date.now() - startedAt,
            error: result.isError ? summarizeContent(result.content) : null,
          });
          return result as CallToolResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await recordToolCall(pool, {
            userId: user.id,
            userEmail: user.email,
            serverSlug: tool.serverSlug,
            serverName: tool.serverName,
            toolName: tool.name,
            exposedToolName: tool.exposedName,
            source: "mcp",
            success: false,
            durationMs: Date.now() - startedAt,
            error: message,
          });
          return {
            content: [{ type: "text", text: `Error calling ${tool.exposedName}: ${message}` }],
            isError: true,
          };
        }
      });

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Gateway MCP request failed", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  router.all("/mcp", (_req, res) => {
    res.status(405).json({
      error: "This gateway MCP endpoint is stateless; use POST with a JSON-RPC body.",
    });
  });

  return router;
}
