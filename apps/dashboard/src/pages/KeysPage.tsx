import { KeyManager } from "../components/KeyManager";

export function KeysPage() {
  return (
    <div>
      <div className="page-title">
        <div>
          <h1>My API keys</h1>
          <div className="page-subtitle">
            Use these keys with any MCP client pointed at the gateway URL <code className="mono">/mcp</code>.
          </div>
        </div>
      </div>
      <div className="card">
        <KeyManager />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Connecting an MCP client</h3>
        <p className="muted">
          Add the gateway as a remote MCP server. The client only needs the gateway URL and one of your
          keys; upstream credentials never leave the cluster.
        </p>
        <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{`{
  "mcpServers": {
    "urumi-gateway": {
      "type": "http",
      "url": "http://app.local/mcp",
      "headers": { "Authorization": "Bearer <your-key>" }
    }
  }
}`}</pre>
      </div>
    </div>
  );
}
