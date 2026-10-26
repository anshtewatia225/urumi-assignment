import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type CallToolResult, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 8080);
const PROFILE = (process.env.MCP_PROFILE ?? "fulfillment").toLowerCase();

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

interface Shipment {
  id: number;
  order_id: number;
  carrier: string;
  destination: string;
  status: string;
  tracking: string;
  created_at: string;
}

const shipments: Shipment[] = [];
let nextShipmentId = 1001;

const carriers = [
  { id: "dhl", name: "DHL Express", base_fee: 6.5, per_kg: 1.4, eta_days: 2 },
  { id: "ups", name: "UPS Ground", base_fee: 4.0, per_kg: 1.1, eta_days: 4 },
  { id: "royal-mail", name: "Royal Mail Tracked", base_fee: 3.2, per_kg: 0.9, eta_days: 5 },
];

const analyticsProducts = [
  { product: "Urumi T-Shirt", units: 42, revenue: 1008.0, trend: "up" },
  { product: "Urumi Coffee Mug", units: 31, revenue: 449.5, trend: "flat" },
  { product: "Urumi Sticker Pack", units: 18, revenue: 90.0, trend: "down" },
  { product: "Urumi Hoodie", units: 12, revenue: 598.8, trend: "up" },
  { product: "Urumi Notebook", units: 9, revenue: 71.1, trend: "flat" },
];

function buildFulfillment(): McpServer {
  const server = new McpServer({ name: "fulfillment-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.tool("list_carriers", "List the shipping carriers this fulfillment service can book.", {}, async (): Promise<CallToolResult> => ok(carriers));

  server.tool(
    "get_shipping_quote",
    "Get a shipping quote for a destination and parcel weight. Currency is USD.",
    {
      destination: z.string().min(1).describe("Destination city and country, e.g. Berlin, DE"),
      weight_kg: z.number().positive().optional().describe("Parcel weight in kilograms (default 1)"),
      carrier_id: z.string().optional().describe("Restrict the quote to one carrier id"),
    },
    async (args): Promise<CallToolResult> => {
      const weight = args.weight_kg ?? 1;
      const options = carriers
        .filter((carrier) => !args.carrier_id || carrier.id === args.carrier_id)
        .map((carrier) => ({
          carrier_id: carrier.id,
          carrier_name: carrier.name,
          destination: args.destination,
          weight_kg: weight,
          price_usd: Number((carrier.base_fee + carrier.per_kg * weight).toFixed(2)),
          eta_days: carrier.eta_days,
        }));
      if (options.length === 0) return fail(`Unknown carrier_id ${args.carrier_id}`);
      return ok({ destination: args.destination, quotes: options });
    },
  );

  server.tool(
    "create_shipment",
    "Book a shipment for an existing store order. Returns a tracking number.",
    {
      order_id: z.number().int().positive().describe("Store order id"),
      carrier_id: z.string().min(1).describe("Carrier id from list_carriers"),
      destination: z.string().min(1).describe("Destination city and country"),
    },
    async (args): Promise<CallToolResult> => {
      const carrier = carriers.find((item) => item.id === args.carrier_id);
      if (!carrier) return fail(`Unknown carrier_id ${args.carrier_id}`);
      const shipment: Shipment = {
        id: nextShipmentId++,
        order_id: args.order_id,
        carrier: carrier.name,
        destination: args.destination,
        status: "label_created",
        tracking: `${carrier.id.toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
        created_at: new Date().toISOString(),
      };
      shipments.push(shipment);
      return ok(shipment);
    },
  );

  // Deliberately shares a tool name with the WooCommerce MCP server so the gateway's
  // collision handling can be demonstrated end to end.
  server.tool("list_orders", "List shipments booked through the fulfillment service, newest first.", {}, async (): Promise<CallToolResult> => ok([...shipments].sort((a, b) => b.created_at.localeCompare(a.created_at))));

  return server;
}

function buildAnalytics(): McpServer {
  const server = new McpServer({ name: "analytics-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.tool(
    "sales_summary",
    "Return a sales summary for the last N days (default 7). Currency is USD.",
    { days: z.number().int().min(1).max(90).optional().describe("Window in days (default 7)") },
    async (args): Promise<CallToolResult> => {
      const days = args.days ?? 7;
      const orders = 24 + days * 3;
      const revenue = Number((orders * 38.5).toFixed(2));
      return ok({ window_days: days, orders, revenue_usd: revenue, average_order_value: Number((revenue / orders).toFixed(2)) });
    },
  );

  server.tool(
    "top_products",
    "Return the best selling products by units in the current period.",
    { limit: z.number().int().min(1).max(20).optional().describe("How many products to return (default 5)") },
    async (args): Promise<CallToolResult> => ok(analyticsProducts.slice(0, args.limit ?? 5)),
  );

  server.tool(
    "customer_count",
    "Return the number of active customers and new customers this period.",
    {},
    async (): Promise<CallToolResult> => ok({ active_customers: 318, new_customers: 27 }),
  );

  return server;
}

function buildServer(): McpServer {
  return PROFILE === "analytics" ? buildAnalytics() : buildFulfillment();
}

const transports = new Map<string, StreamableHTTPServerTransport>();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: `${PROFILE}-mcp` }));
app.get("/readyz", (_req, res) => res.json({ status: "ready", service: `${PROFILE}-mcp` }));

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  try {
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : undefined;

    let transport: StreamableHTTPServerTransport | undefined;
    if (sessionId) {
      transport = transports.get(sessionId);
      if (!transport) {
        res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
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
      await buildServer().connect(transport);
    }

    if (!transport) {
      res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad request: missing MCP session" }, id: null });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

app.post("/mcp", handleMcpRequest);
app.get("/mcp", handleMcpRequest);
app.delete("/mcp", handleMcpRequest);

const server = app.listen(PORT, () => {
  console.log(`${PROFILE}-mcp listening on port ${PORT}`);
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
