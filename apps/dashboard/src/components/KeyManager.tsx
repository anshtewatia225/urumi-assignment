import { useCallback, useEffect, useState } from "react";
import { api, formatDate } from "../api";
import type { ApiKeyInfo } from "../types";

interface KeyManagerProps {
  userId?: string;
  canIssue?: boolean;
  title?: string;
}

export function KeyManager({ userId, canIssue = true, title = "API keys" }: KeyManagerProps) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [name, setName] = useState("dashboard");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      const result = await api<{ keys: ApiKeyInfo[] }>(`/api/keys${query}`);
      setKeys(result.keys);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load keys");
    }
  }, [userId]);

  useEffect(() => {
    setKeys([]);
    setPlaintext(null);
    void load();
  }, [load]);

  const issue = async () => {
    setBusy(true);
    setError(null);
    setPlaintext(null);
    try {
      const result = await api<{ key: ApiKeyInfo; plaintext: string }>("/api/keys", {
        method: "POST",
        body: JSON.stringify({ name, userId }),
      });
      setPlaintext(result.plaintext);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm("Revoke this key? Clients using it will be rejected immediately.")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/keys/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {title && <h3 style={{ margin: 0 }}>{title}</h3>}
      {canIssue && (
        <div className="row">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Key label"
            style={{ maxWidth: 240 }}
          />
          <button className="btn primary small" onClick={issue} disabled={busy || !name.trim()}>
            Issue key
          </button>
        </div>
      )}
      {plaintext && (
        <div className="banner success">
          <div style={{ marginBottom: 6 }}>
            Copy this key now. It is shown once and never stored in plaintext.
          </div>
          <code className="mono" style={{ wordBreak: "break-all" }}>{plaintext}</code>
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {keys.length === 0 ? (
        <div className="muted">No API keys yet.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td className="mono">
                    {key.prefix}...{key.last4}
                  </td>
                  <td>{formatDate(key.createdAt)}</td>
                  <td>{formatDate(key.lastUsedAt)}</td>
                  <td>
                    {key.revokedAt ? (
                      <span className="badge unreachable">revoked</span>
                    ) : (
                      <span className="badge connected">active</span>
                    )}
                  </td>
                  <td>
                    {!key.revokedAt && (
                      <button className="btn danger small" onClick={() => revoke(key.id)} disabled={busy}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
