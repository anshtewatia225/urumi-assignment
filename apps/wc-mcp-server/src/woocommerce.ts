import { createHmac, randomBytes } from "node:crypto";
import { config } from "./config.js";

type QueryValue = string | number | boolean | undefined;

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

/**
 * WooCommerce only enables basic auth for SSL requests, but this MCP server talks to
 * WordPress over plain HTTP inside the cluster. OAuth 1.0a (one-legged) is accepted by
 * WooCommerce for non-SSL requests and never sends the consumer secret on the wire.
 * The signing base must use the site's public host (WP_HOME) while the actual request
 * is sent to the in-cluster Service.
 */
function buildOAuthQuery(options: {
  method: string;
  oauthBaseUrl: string;
  path: string;
  query: Record<string, QueryValue>;
  consumerKey: string;
  consumerSecret: string;
}): URLSearchParams {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: options.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
  };

  const pairs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(options.query)) {
    if (value !== undefined && value !== null && value !== "") {
      pairs.push([key, String(value)]);
    }
  }
  for (const [key, value] of Object.entries(oauthParams)) {
    pairs.push([key, value]);
  }

  const encodedPairs = pairs.map(([key, value]) => [rfc3986(key), rfc3986(value)] as [string, string]);
  encodedPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parameterString = encodedPairs.map(([key, value]) => rfc3986(`${key}=${value}`)).join("%26");

  const base = new URL(options.oauthBaseUrl);
  base.protocol = "http:";
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${options.path}`;
  base.search = "";
  base.hash = "";

  const stringToSign = `${options.method}&${rfc3986(base.toString())}&${parameterString}`;
  const signature = createHmac("sha256", `${options.consumerSecret}&`)
    .update(stringToSign)
    .digest("base64");

  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(oauthParams)) {
    result.append(key, value);
  }
  result.append("oauth_signature", signature);
  return result;
}

export class WooCommerceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "WooCommerceError";
  }
}

export interface ListProductsArgs {
  search?: string;
  perPage?: number;
  page?: number;
  status?: string;
}

export interface CreateProductArgs {
  name: string;
  regularPrice: string;
  description?: string;
  sku?: string;
  status?: string;
}

export interface ListOrdersArgs {
  status?: string;
  after?: string;
  before?: string;
  perPage?: number;
  page?: number;
}

export class WooCommerceClient {
  private readonly baseUrl: string;

  constructor(
    private readonly options: {
      baseUrl: string;
      oauthBaseUrl: string;
      consumerKey: string;
      consumerSecret: string;
      timeoutMs: number;
    } = config.woocommerce,
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    query: Record<string, QueryValue> = {},
    body?: unknown,
  ): Promise<T> {
    const requestPath = `/wp-json/wc/v3${path}`;
    const url = new URL(`${this.baseUrl}${requestPath}`);
    const oauthQuery = buildOAuthQuery({
      method,
      oauthBaseUrl: this.options.oauthBaseUrl,
      path: requestPath,
      query,
      consumerKey: this.options.consumerKey,
      consumerSecret: this.options.consumerSecret,
    });
    for (const [key, value] of oauthQuery) {
      url.searchParams.append(key, value);
    }
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.append(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new WooCommerceError(`Could not reach WooCommerce store: ${reason}`);
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as Record<string, unknown>).message)
          : `WooCommerce request ${method} ${path} failed with HTTP ${response.status}`;
      throw new WooCommerceError(message, response.status, parsed);
    }

    return parsed as T;
  }

  async listProducts(args: ListProductsArgs): Promise<unknown[]> {
    return this.request("GET", "/products", {
      search: args.search,
      per_page: args.perPage,
      page: args.page,
      status: args.status,
    });
  }

  async createProduct(args: CreateProductArgs): Promise<Record<string, unknown>> {
    return this.request("POST", "/products", {}, {
      name: args.name,
      regular_price: args.regularPrice,
      description: args.description ?? "",
      sku: args.sku,
      status: args.status ?? "publish",
      type: "simple",
    });
  }

  async listOrders(args: ListOrdersArgs): Promise<unknown[]> {
    return this.request("GET", "/orders", {
      status: args.status,
      after: args.after,
      before: args.before,
      per_page: args.perPage,
      page: args.page,
      orderby: "date",
      order: "desc",
    });
  }

  async getOrder(id: number): Promise<Record<string, unknown>> {
    return this.request("GET", `/orders/${id}`);
  }

  async updateOrderStatus(id: number, status: string): Promise<Record<string, unknown>> {
    return this.request("PUT", `/orders/${id}`, {}, { status });
  }
}

export function toProductSummary(product: Record<string, any>) {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    status: product.status,
    type: product.type,
    price: product.price,
    regular_price: product.regular_price,
    sale_price: product.sale_price,
    sku: product.sku,
    stock_status: product.stock_status,
    stock_quantity: product.stock_quantity,
    permalink: product.permalink,
    created_at: product.date_created,
  };
}

export function toOrderSummary(order: Record<string, any>) {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    currency: order.currency,
    total: order.total,
    date_created: order.date_created,
    date_modified: order.date_modified,
    payment_method: order.payment_method_title,
    customer: {
      id: order.customer_id,
      name: [order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(" "),
      email: order.billing?.email,
    },
    items: Array.isArray(order.line_items)
      ? order.line_items.map((item: Record<string, any>) => ({
          id: item.id,
          product_id: item.product_id,
          name: item.name,
          quantity: item.quantity,
          total: item.total,
        }))
      : [],
  };
}
