import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, formatDate } from "../api";
import { KeyManager } from "../components/KeyManager";
import type { User } from "../types";

export function MembersPage({ currentUser }: { currentUser: User }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api<{ users: User[] }>("/api/users");
      setUsers(result.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setInviteBusy(true);
    setError(null);
    setTemporaryPassword(null);
    try {
      const result = await api<{ user: User; temporaryPassword?: string }>("/api/users", {
        method: "POST",
        body: JSON.stringify({ email, name, role }),
      });
      setTemporaryPassword(result.temporaryPassword ?? null);
      setEmail("");
      setName("");
      setRole("member");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite member");
    } finally {
      setInviteBusy(false);
    }
  };

  const changeRole = async (user: User, nextRole: "admin" | "member") => {
    setError(null);
    try {
      await api(`/api/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ role: nextRole }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change role");
    }
  };

  const remove = async (user: User) => {
    if (!window.confirm(`Delete ${user.email}? Their sessions and keys are removed too.`)) return;
    setError(null);
    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      if (selectedUserId === user.id) setSelectedUserId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-title" style={{ marginBottom: 0 }}>
        <div>
          <h1>Members</h1>
          <div className="page-subtitle">Invite teammates, manage roles, and issue or revoke their keys.</div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {temporaryPassword && (
        <div className="banner success">
          Member invited. Share this temporary password once:
          <div className="mono" style={{ marginTop: 6 }}>{temporaryPassword}</div>
        </div>
      )}

      <form className="card" onSubmit={invite}>
        <h3 style={{ marginTop: 0 }}>Invite a member</h3>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="field" style={{ flex: "1 1 220px", marginBottom: 0 }}>
            <label>Email</label>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </div>
          <div className="field" style={{ flex: "1 1 200px", marginBottom: 0 }}>
            <label>Name</label>
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="field" style={{ flex: "0 0 140px", marginBottom: 0 }}>
            <label>Role</label>
            <select value={role} onChange={(event) => setRole(event.target.value as "member" | "admin")}>
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button className="btn primary" type="submit" disabled={inviteBusy}>
            {inviteBusy ? "Inviting..." : "Invite"}
          </button>
        </div>
      </form>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Team</h3>
        {loading ? (
          <div className="muted">Loading...</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Joined</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      {user.name} {user.id === currentUser.id && <span className="badge">you</span>}
                    </td>
                    <td>{user.email}</td>
                    <td>
                      <select
                        value={user.role}
                        onChange={(event) => void changeRole(user, event.target.value as "admin" | "member")}
                        style={{ maxWidth: 130 }}
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button
                          className="btn small"
                          onClick={() => setSelectedUserId(selectedUserId === user.id ? null : user.id)}
                        >
                          {selectedUserId === user.id ? "Hide keys" : "Keys"}
                        </button>
                        <button
                          className="btn danger small"
                          onClick={() => void remove(user)}
                          disabled={user.id === currentUser.id}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedUser && (
        <div className="card">
          <KeyManager
            userId={selectedUser.id}
            title={`API keys for ${selectedUser.name}`}
            canIssue
          />
        </div>
      )}
    </div>
  );
}
