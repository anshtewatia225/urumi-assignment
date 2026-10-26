import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WooCommerceClient, toOrderSummary, toProductSummary } from "./woocommerce.js";

function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

const orderStatuses = [
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
] as const;

export function buildServer(client: WooCommerceClient): McpServer {
  const server = new McpServer(
    { name: "woocommerce-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "list_products",
    "List products in the WooCommerce store. Optionally filter by a search term or status.",
    {
      search: z.string().optional().describe("Free-text search across product names"),
      status: z.string().optional().describe("Product status, e.g. publish or draft"),
      per_page: z.number().int().min(1).max(100).optional().describe("Page size (default 20)"),
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const products = await client.listProducts({
          search: args.search,
          status: args.status,
          perPage: args.per_page,
          page: args.page,
        });
        return ok(products.map((product) => toProductSummary(product as Record<string, any>)));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "create_product",
    "Create a simple product in the WooCommerce store and publish it to the storefront.",
    {
      name: z.string().min(1).describe("Product name"),
      regular_price: z.string().min(1).describe("Regular price as a string, e.g. 19.99"),
      description: z.string().optional().describe("Product description"),
      sku: z.string().optional().describe("Optional SKU"),
      status: z.enum(["publish", "draft", "pending", "private"]).optional().describe("Defaults to publish"),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const product = await client.createProduct({
          name: args.name,
          regularPrice: args.regular_price,
          description: args.description,
          sku: args.sku,
          status: args.status,
        });
        return ok(toProductSummary(product));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "list_orders",
    "List orders from the WooCommerce store. Use ISO-8601 after/before bounds to filter by date, e.g. today's orders.",
    {
      status: z.string().optional().describe("Order status filter, e.g. processing"),
      after: z.string().optional().describe("ISO-8601 lower bound on order creation time"),
      before: z.string().optional().describe("ISO-8601 upper bound on order creation time"),
      per_page: z.number().int().min(1).max(100).optional().describe("Page size (default 20)"),
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const orders = await client.listOrders({
          status: args.status,
          after: args.after,
          before: args.before,
          perPage: args.per_page,
          page: args.page,
        });
        return ok(orders.map((order) => toOrderSummary(order as Record<string, any>)));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "get_order",
    "Get a single order by id, including line items and customer details.",
    {
      id: z.number().int().positive().describe("WooCommerce order id"),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const order = await client.getOrder(args.id);
        return ok(toOrderSummary(order));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.tool(
    "update_order_status",
    "Update the status of an existing order.",
    {
      id: z.number().int().positive().describe("WooCommerce order id"),
      status: z.enum(orderStatuses).describe("New order status"),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const order = await client.updateOrderStatus(args.id, args.status);
        return ok(toOrderSummary(order));
      } catch (error) {
        return fail(error);
      }
    },
  );

  return server;
}
