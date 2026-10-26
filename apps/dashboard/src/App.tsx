import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import type { User } from "./types";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { ServersPage } from "./pages/ServersPage";
import { MembersPage } from "./pages/MembersPage";
import { KeysPage } from "./pages/KeysPage";
import { AuditPage } from "./pages/AuditPage";
import { ChatPage } from "./pages/ChatPage";

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ user: User }>("/api/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="auth-shell">
        <div className="muted">Loading dashboard...</div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }

  return (
    <BrowserRouter>
      <Layout user={user} onLogout={() => setUser(null)}>
        <Routes>
          <Route
            path="/"
            element={<Navigate to={user.role === "admin" ? "/servers" : "/chat"} replace />}
          />
          {user.role === "admin" && <Route path="/servers" element={<ServersPage />} />}
          {user.role === "admin" && (
            <Route path="/members" element={<MembersPage currentUser={user} />} />
          )}
          <Route path="/keys" element={<KeysPage />} />
          <Route path="/audit" element={<AuditPage isAdmin={user.role === "admin"} />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
