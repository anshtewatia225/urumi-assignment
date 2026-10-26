import { Router } from "express";
import { z } from "zod";
import type { Pool } from "pg";
import { requireSession } from "../auth.js";
import { recordToolCall } from "../audit.js";
import { env } from "../env.js";
import { META_TOOL_LIST_SERVERS } from "../mcpEndpoint.js";
import type { AggregatedTool, ServerStatus, UpstreamManager } from "../upstream.js";

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(20000),
      }),
    )
    .min(1)
    .max(50),
});

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments?: string };
}

interface CompletionResponse {
  choices?: Array<{
    message?: {
      role: string;
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
}

async function callLlm(messages: ChatMessage[], tools: unknown[]): Promise<CompletionResponse> {
  const response = await fetch(`${env.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.llm.apiKey}`,
      "X-Title": "Urumi MCP Gateway",
    },
    body: JSON.stringify({
      model: env.llm.model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(env.llm.timeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM request failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return (await response.json()) as CompletionResponse;
}

function summarizeToolContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "text" in block) {
      parts.push(String((block as Record<string, unknown>).text));
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n").slice(0, 20000);
}

function serversSummary(servers: ServerStatus[]) {
  return servers.map((server) => ({
    name: server.name,
    slug: server.slug,
    status: server.status,
    enabled: server.enabled,
    toolCount: server.tools.length,
    exposedTools: server.exposedTools,
  }));
}

export function chatRouter(pool: Pool, manager: UpstreamManager): Router {
  const router = Router();
  router.use(requireSession);

  router.post("/", async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid chat payload", details: parsed.error.flatten() });
      return;
    }
    if (!env.llm.apiKey) {
      res.status(400).json({
        error: "Chat is not configured. Set LLM_API_KEY (and optionally LLM_BASE_URL / LLM_MODEL).",
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const user = req.user!;
      const { tools, servers } = await manager.aggregate();
      const byExposedName = new Map<string, AggregatedTool>();
      for (const tool of tools) {
        byExposedName.set(tool.exposedName, tool);
      }

      const openAiTools = [
        ...tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.exposedName,
            description: `[${tool.serverName}] ${tool.description ?? tool.name}`,
            parameters: tool.inputSchema,
          },
        })),
        {
          type: "function",
          function: {
            name: META_TOOL_LIST_SERVERS,
            description: "List upstream MCP servers with status and exposed tool names.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        },
      ];

      const now = new Date();
      const systemPrompt = [
        "You are the assistant inside the Urumi WooCommerce hosting dashboard.",
        "You act on behalf of the logged-in team member and can only use the tools provided.",
        "Tools are named <server-slug>__<tool-name>. Choose tools by their description and the server slug.",
        "When asked about orders from today, compute ISO-8601 after/before bounds for the current day in UTC and pass them to the appropriate list_orders tool.",
        "Never invent data. If a tool fails, explain the error briefly.",
        `Current time (UTC): ${now.toISOString()}.`,
      ].join(" ");

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...parsed.data.messages,
      ];

      send("start", {
        toolCount: tools.length,
        servers: serversSummary(servers),
      });

      let answered = false;
      for (let iteration = 0; iteration < env.llm.maxIterations; iteration += 1) {
        const completion = await callLlm(messages, openAiTools);
        const message = completion.choices?.[0]?.message;
        if (!message) {
          throw new Error("The model returned an empty response");
        }
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (toolCalls.length === 0) {
          const content = typeof message.content === "string" ? message.content : "";
          send("assistant", { content });
          answered = true;
          break;
        }

        messages.push({
          role: "assistant",
          content: message.content ?? null,
          tool_calls: toolCalls as unknown[],
        });

        for (const call of toolCalls) {
          const name = call.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
          } catch {
            args = {};
          }
          send("tool_call", { id: call.id, name, arguments: args });

          const startedAt = Date.now();
          let output = "";
          let isError = false;

          if (name === META_TOOL_LIST_SERVERS) {
            output = JSON.stringify(serversSummary(servers), null, 2);
          } else {
            const tool = byExposedName.get(name);
            if (!tool) {
              output = `Unknown tool ${name}`;
              isError = true;
            } else {
              try {
                const result = await manager.callToolById(tool.serverId, tool.name, args);
                isError = Boolean(result.isError);
                output = summarizeToolContent(result.content);
              } catch (error) {
                isError = true;
                output = error instanceof Error ? error.message : String(error);
              }
              await recordToolCall(pool, {
                userId: user.id,
                userEmail: user.email,
                serverSlug: tool.serverSlug,
                serverName: tool.serverName,
                toolName: tool.name,
                exposedToolName: tool.exposedName,
                source: "chat",
                success: !isError,
                durationMs: Date.now() - startedAt,
                error: isError ? output.slice(0, 2000) : null,
              });
            }
          }

          send("tool_result", { id: call.id, name, content: output, isError });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content: output,
          });
        }
      }

      if (!answered) {
        send("assistant", {
          content:
            "I could not finish answering within the tool-call budget. Try a more specific question.",
        });
      }
      send("done", {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send("error", { message });
    } finally {
      res.end();
    }
  });

  return router;
}
