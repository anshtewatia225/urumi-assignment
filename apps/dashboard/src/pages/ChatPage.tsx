import { useRef, useState, type KeyboardEvent } from "react";

interface ToolActivity {
  id: string;
  name: string;
  args: unknown;
  result?: string;
  isError?: boolean;
}

interface ChatItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  tools: ToolActivity[];
}

interface StartEvent {
  toolCount: number;
  servers: Array<{ slug: string; status: string; toolCount: number }>;
}

function id(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function updateItem(items: ChatItem[], itemId: string, updater: (item: ChatItem) => ChatItem): ChatItem[] {
  return items.map((item) => (item.id === itemId ? updater(item) : item));
}

export function ChatPage() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<StartEvent | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      if (logRef.current) {
        logRef.current.scrollTop = logRef.current.scrollHeight;
      }
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    const history = items
      .filter((item) => item.content.trim().length > 0)
      .map((item) => ({ role: item.role, content: item.content }));

    const userItem: ChatItem = { id: id(), role: "user", content: text, tools: [] };
    const assistantId = id();
    const assistantItem: ChatItem = { id: assistantId, role: "assistant", content: "", tools: [] };
    setItems((current) => [...current, userItem, assistantItem]);
    setInput("");
    setError(null);
    setSending(true);
    scrollToBottom();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...history, { role: "user", content: text }] }),
      });

      if (!response.ok || !response.body) {
        let message = `Chat request failed with ${response.status}`;
        try {
          const data = (await response.json()) as { error?: string };
          if (data.error) message = data.error;
        } catch {
          // ignore
        }
        throw new Error(message);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleChunk(chunk);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat failed";
      setError(message);
      setItems((current) =>
        updateItem(current, assistantId, (item) => ({
          ...item,
          content: item.content || `Error: ${message}`,
        })),
      );
    } finally {
      setSending(false);
      scrollToBottom();
    }

    function handleChunk(chunk: string) {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      if (dataLines.length === 0) return;
      let data: any;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        return;
      }

      if (event === "start") {
        setInfo(data as StartEvent);
      } else if (event === "tool_call") {
        setItems((current) =>
          updateItem(current, assistantId, (item) => ({
            ...item,
            tools: [
              ...item.tools,
              { id: String(data.id), name: String(data.name), args: data.arguments },
            ],
          })),
        );
        scrollToBottom();
      } else if (event === "tool_result") {
        setItems((current) =>
          updateItem(current, assistantId, (item) => ({
            ...item,
            tools: item.tools.map((tool) =>
              tool.id === String(data.id)
                ? { ...tool, result: String(data.content ?? ""), isError: Boolean(data.isError) }
                : tool,
            ),
          })),
        );
      } else if (event === "assistant") {
        setItems((current) =>
          updateItem(current, assistantId, (item) => ({ ...item, content: String(data.content ?? "") })),
        );
        scrollToBottom();
      } else if (event === "error") {
        setError(String(data.message ?? "Chat failed"));
        setItems((current) =>
          updateItem(current, assistantId, (item) => ({
            ...item,
            content: item.content || `Error: ${String(data.message ?? "Chat failed")}`,
          })),
        );
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="stack" style={{ gap: 12, height: "100%" }}>
      <div className="page-title" style={{ marginBottom: 0 }}>
        <div>
          <h1>Chat agent</h1>
          <div className="page-subtitle">
            The agent calls the same gateway tools as your external MCP client, and every call is audited
            under your account.
            {info && ` ${info.toolCount} tools available.`}
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="chat-shell">
        <div className="chat-log" ref={logRef}>
          {items.length === 0 && (
            <div className="empty">
              Ask about today&apos;s orders, create a product, or get a shipping quote.
            </div>
          )}
          {items.map((item) => (
            <div className={`message ${item.role}`} key={item.id}>
              {item.content || (item.role === "assistant" ? <span className="muted">Thinking...</span> : null)}
              {item.tools.length > 0 && (
                <div className="tool-activity">
                  {item.tools.map((tool) => (
                    <details className="tool-call" key={tool.id}>
                      <summary>
                        {tool.name}{" "}
                        {tool.isError ? (
                          <span className="error-text">(failed)</span>
                        ) : tool.result !== undefined ? (
                          <span className="success-text">(ok)</span>
                        ) : (
                          <span className="muted">(running)</span>
                        )}
                      </summary>
                      <pre>{JSON.stringify(tool.args, null, 2)}</pre>
                      {tool.result !== undefined && <pre>{tool.result}</pre>}
                    </details>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the tool-using agent... (Enter to send, Shift+Enter for a new line)"
            disabled={sending}
          />
          <button className="btn primary" onClick={() => void send()} disabled={sending || !input.trim()}>
            {sending ? "Working..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
