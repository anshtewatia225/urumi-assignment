import { useCallback, useEffect, useState } from "react";
import { api, formatDate, formatDuration } from "../api";
import type { AuditEntry } from "../types";

export function AuditPage({ isAdmin }: { isAdmin: boolean }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState("");
  const [source, setSource] = useState("");
  const [limit, setLimit] = useState(100);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (tool.trim()) params.set("tool", tool.trim());
      if (source) params.set("source", source);
      const result = await api<{ entries: AuditEntry[] }>(`/api/audit?${params.toString()}`);
      setEntries(result.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, [tool, source, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="page-title">
        <div>
          <h1>Audit log</h1>
          <div className="page-subtitle">
            Every tool call through the gateway, attributed to the calling user.
            {!isAdmin && " You are seeing your own calls only."}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row">
          <div className="field" style={{ marginBottom: 0, flex: "1 1 220px" }}>
            <label>Tool contains</label>
            <input value={tool} onChange={(event) => setTool(event.target.value)} placeholder="list_orders" />
          </div>
          <div className="field" style={{ marginBottom: 0, flex: "0 0 150px" }}>
            <label>Source</label>
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="">all</option>
              <option value="mcp">mcp</option>
              <option value="chat">chat</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0, flex: "0 0 120px" }}>
            <label>Limit</label>
            <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={500}>500</option>
            </select>
          </div>
          <button className="btn" onClick={() => void load()} disabled={loading} style={{ alignSelf: "flex-end" }}>
            {loading ? "Loading..." : "Apply"}
          </button>
        </div>
      </div>

      {error && <div className="banner error" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="card">
        {entries.length === 0 && !loading ? (
          <div className="empty">No tool calls recorded yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Source</th>
                  <th>Server</th>
                  <th>Tool</th>
                  <th>Duration</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="muted">{formatDate(entry.createdAt)}</td>
                    <td>{entry.userEmail ?? "-"}</td>
                    <td>
                      <span className={`badge ${entry.source === "chat" ? "chat" : ""}`}>{entry.source}</span>
                    </td>
                    <td className="mono">{entry.serverSlug ?? "-"}</td>
                    <td className="mono">{entry.exposedToolName ?? entry.toolName ?? "-"}</td>
                    <td className="muted">{formatDuration(entry.durationMs)}</td>
                    <td>
                      {entry.success ? (
                        <span className="badge connected">ok</span>
                      ) : (
                        <span className="badge unreachable">failed</span>
                      )}
                      {entry.error && (
                        <div className="error-text" style={{ maxWidth: 320, marginTop: 4, wordBreak: "break-word" }}>
                          {entry.error}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
