import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../api";
import type { User } from "../types";

interface LayoutProps {
  user: User;
  onLogout: () => void;
  children: ReactNode;
}

export function Layout({ user, onLogout, children }: LayoutProps) {
  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      onLogout();
    }
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          Urumi <span>MCP</span>
        </div>
        <nav className="nav">
          {user.role === "admin" && <NavLink to="/servers">Servers</NavLink>}
          {user.role === "admin" && <NavLink to="/members">Members</NavLink>}
          <NavLink to="/keys">My API keys</NavLink>
          <NavLink to="/audit">Audit log</NavLink>
          <NavLink to="/chat">Chat agent</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div>
            <div>{user.name}</div>
            <div>{user.email}</div>
            <span className="badge">{user.role}</span>
          </div>
          <button className="btn ghost small" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
