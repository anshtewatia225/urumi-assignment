import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { WooCommerceClient } from "./woocommerce.js";
import { buildServer } from "./server.js";

const client = new WooCommerceClient();
const transports = new Map<string, StreamableHTTPServerTransport>();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", service: "wc-mcp-server" });
});

app.get("/readyz", (_req, res) => {
  res.status(200).json({ status: "ready", service: "wc-mcp-server" });
});

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  try {
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;

    let transport: StreamableHTTPServerTransport | undefined;
    if (sessionId) {
      transport = transports.get(sessionId);
      if (!transport) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
    } else if (req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedId) => {
          transports.set(initializedId, transport as StreamableHTTPServerTransport);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) {
          transports.delete(transport.sessionId);
        }
      };
      await buildServer(client).connect(transport);
    }

    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad request: missing MCP session" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

app.post("/mcp", handleMcpRequest);
app.get("/mcp", handleMcpRequest);
app.delete("/mcp", handleMcpRequest);

const server = app.listen(config.port, () => {
  console.log(`wc-mcp-server listening on port ${config.port}`);
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  for (const transport of transports.values()) {
    try {
      await transport.close();
    } catch {
      // ignore
    }
  }
  transports.clear();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
