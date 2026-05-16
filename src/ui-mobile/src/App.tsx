import { useState } from "react";
import { ConnectScreen } from "./screens/ConnectScreen";
import type { SavedConnection } from "./types";

// Phase 5 wires the pair / connect / forget flow. Phase 6 will add a
// workspaces screen that the ConnectScreen routes to on success.

export function App() {
  const [active, setActive] = useState<SavedConnection | null>(null);

  if (!active) {
    return <ConnectScreen onConnected={setActive} />;
  }

  return (
    <div className="shell">
      <header className="header">
        <h1>{active.name}</h1>
        <p className="subtitle">
          {active.host}:{active.port}
        </p>
      </header>
      <main className="main">
        <p className="status">Connected. Workspaces UI ships in Phase 6.</p>
        <button className="secondary" onClick={() => setActive(null)}>
          Disconnect
        </button>
      </main>
    </div>
  );
}
