import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import type { ServerStatus } from "../types";

interface ServerDraft {
  name: string;
  url: string;
  authType: "none" | "bearer" | "header";
  headerName: string;
  secret: string;
  enabled: boolean;
}

const emptyDraft: ServerDraft = {
  name: "",
  url: "",
  authType: "none",
  headerName: "",
  secret: "",
  enabled: true,
};

function ServerForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: ServerStatus;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ServerDraft>(
    initial
      ? {
          name: initial.name,
          url: initial.url,
          authType: initial.authType,
          headerName: initial.headerName ?? "",
          secret: "",
          enabled: initial.enabled,
        }
      : emptyDraft,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof ServerDraft>(key: K, value: ServerDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const payload: Record<string, unknown> = {
      name: draft.name,
      url: draft.url,
      authType: draft.authType,
      enabled: draft.enabled,
    };
    if (draft.authType === "header") payload.headerName = draft.headerName;
    if (draft.secret) payload.secret = draft.secret;
    try {
      if (initial) {
        await api(`/api/servers/${initial.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/servers", { method: "POST", body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h3 style={{ margin: 0 }}>{initial ? `Edit ${initial.name}` : "Add an upstream MCP server"}</h3>
      <div className="split">
        <div>
          <div className="field">
            <label>Name</label>
            <input value={draft.name} onChange={(event) => set("name", event.target.value)} required />
          </div>
          <div className="field">
            <label>Streamable HTTP URL</label>
            <input
              value={draft.url}
              onChange={(event) => set("url", event.target.value)}
              placeholder="http://wc-mcp.store.svc.cluster.local:8080/mcp"
              required
            />
          </div>
          <div className="field">
            <label>Authentication</label>
            <select
              value={draft.authType}
              onChange={(event) => set("authType", event.target.value as ServerDraft["authType"])}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </div>
        </div>
        <div>
          {draft.authType === "header" && (
            <div className="field">
              <label>Header name</label>
              <input
                value={draft.headerName}
                onChange={(event) => set("headerName", event.target.value)}
                placeholder="X-Api-Key"
                required
              />
            </div>
          )}
          {draft.authType !== "none" && (
            <div className="field">
              <label>Credential {initial ? "(leave blank to keep current)" : ""}</label>
              <input
                type="password"
                value={draft.secret}
                onChange={(event) => set("secret", event.target.value)}
                autoComplete="off"
              />
            </div>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => set("enabled", event.target.checked)}
            />
            Enabled
          </label>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Saving..." : initial ? "Save changes" : "Add server"}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ServersPage() {
  const [servers, setServers] = useState<ServerStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ServerStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api<{ servers: ServerStatus[] }>(
        `/api/servers${refresh ? "?refresh=1" : ""}`,
      );
      setServers(result.servers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load servers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = (server: ServerStatus) =>
    mutate(server.id, () =>
      api(`/api/servers/${server.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !server.enabled }),
      }),
    );

  const refresh = (server: ServerStatus) =>
    mutate(server.id, () => api(`/api/servers/${server.id}/refresh`, { method: "POST" }));

  const remove = (server: ServerStatus) => {
    if (!window.confirm(`Remove ${server.name}? Its tools disappear from the gateway immediately.`)) {
      return;
    }
    void mutate(server.id, () => api(`/api/servers/${server.id}`, { method: "DELETE" }));
  };

  return (
    <div>
      <div className="page-title">
        <div>
          <h1>MCP servers</h1>
          <div className="page-subtitle">
            Upstream servers this gateway aggregates. Credentials stay server-side.
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => void load(true)} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh all"}
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setCreating(true);
              setEditing(null);
            }}
          >
            Add server
          </button>
        </div>
      </div>

      {error && <div className="banner error" style={{ marginBottom: 16 }}>{error}</div>}

      {(creating || editing) && (
        <div style={{ marginBottom: 18 }}>
          <ServerForm
            initial={editing ?? undefined}
            onCancel={() => {
              setCreating(false);
              setEditing(null);
            }}
            onSaved={() => {
              setCreating(false);
              setEditing(null);
              void load();
            }}
          />
        </div>
      )}

      {!loading && servers.length === 0 && <div className="empty card">No servers registered yet.</div>}

      <div className="grid">
        {servers.map((server) => (
          <div className="card stack" key={server.id}>
            <div className="server-card-head">
              <div>
                <h3>{server.name}</h3>
                <div className="mono muted">{server.slug}</div>
              </div>
              <span className={`badge ${server.status}`}>{server.status}</span>
            </div>

            <div className="server-meta">
              <div className="mono" style={{ wordBreak: "break-all" }}>
                {server.url}
              </div>
              <div>
                Auth: {server.authType}
                {server.authType === "header" && server.headerName ? ` (${server.headerName})` : ""}
              </div>
            </div>

            {server.error && <div className="error-text">{server.error}</div>}

            <div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                {server.tools.length} tool{server.tools.length === 1 ? "" : "s"}
              </div>
              {server.tools.map((tool, index) => (
                <div className="tool-row" key={tool.name}>
                  <div>
                    <span className="chip">{server.exposedTools[index] ?? tool.name}</span>
                  </div>
                  <div className="muted" style={{ textAlign: "right", maxWidth: "55%" }}>
                    {tool.description ?? ""}
                  </div>
                </div>
              ))}
              {server.status === "connected" && server.tools.length === 0 && (
                <div className="muted">Connected, but it exposes no tools.</div>
              )}
              {server.status === "disabled" && (
                <div className="muted">Disabled: its tools are hidden from every client.</div>
              )}
            </div>

            <div className="row">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={server.enabled}
                  disabled={busyId === server.id}
                  onChange={() => void toggleEnabled(server)}
                />
                Enabled
              </label>
              <div className="spacer" />
              <button
                className="btn small"
                onClick={() => void refresh(server)}
                disabled={busyId === server.id}
              >
                Probe
              </button>
              <button
                className="btn small"
                onClick={() => {
                  setEditing(server);
                  setCreating(false);
                }}
              >
                Edit
              </button>
              <button className="btn danger small" onClick={() => remove(server)} disabled={busyId === server.id}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
