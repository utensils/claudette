import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface VersionInfo {
  version: string;
  commit: string | null;
}

// Phase 4 stub. The real screens — ConnectScreen, WorkspacesScreen,
// ChatListScreen, ChatScreen — land in Phases 5-8. For now this is just
// enough to confirm the webview boots and the Rust↔JS bridge works.
export function App() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<VersionInfo>("version")
      .then(setVersion)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="shell">
      <header className="header">
        <h1>Claudette</h1>
        <p className="subtitle">iOS preview</p>
      </header>
      <main className="main">
        <p className="status">
          {error
            ? `Bridge error: ${error}`
            : version
              ? `Rust ${version.version}${version.commit ? ` @ ${version.commit.slice(0, 7)}` : ""}`
              : "Connecting to Rust side…"}
        </p>
        <p className="hint">
          Pair flow, workspace list, and chat view ship in Phases 5-8 of
          the iOS foundation work.
        </p>
      </main>
    </div>
  );
}
