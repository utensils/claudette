import { useEffect, useState } from "react";
import { loadInitialData } from "../services/rpc";
import type { InitialData, SavedConnection, Workspace } from "../types";

interface Props {
  connection: SavedConnection;
  onOpenWorkspace: (ws: Workspace) => void;
  onDisconnect: () => void;
}

export function WorkspacesScreen({
  connection,
  onOpenWorkspace,
  onDisconnect,
}: Props) {
  const [data, setData] = useState<InitialData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setError(null);
    setRefreshing(true);
    try {
      const result = await loadInitialData(connection.id);
      setData(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  const repoFor = (workspace: Workspace) =>
    data?.repositories.find((r) => r.id === workspace.repository_id);

  const active = data?.workspaces.filter((w) => w.status === "Active") ?? [];

  return (
    <div className="shell">
      <header className="header header-row">
        <div>
          <h1>{connection.name}</h1>
          <p className="subtitle">{active.length} active workspaces</p>
        </div>
        <button className="ghost-btn" onClick={onDisconnect}>
          Disconnect
        </button>
      </header>
      <main className="main">
        {error && <div className="error">{error}</div>}
        {!data && !error && <p className="status">Loading workspaces…</p>}
        {data && active.length === 0 && (
          <p className="hint">
            No active workspaces on this server. Create one from the desktop
            app to drive it from here.
          </p>
        )}
        <ul className="conn-list">
          {active.map((w) => {
            const repo = repoFor(w);
            return (
              <li key={w.id}>
                <button
                  className="conn-row-main"
                  onClick={() => onOpenWorkspace(w)}
                >
                  <span className="conn-name">{w.name}</span>
                  <span className="conn-host">
                    {repo?.name ?? "—"} · {w.branch_name}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <button
          className="secondary"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </main>
    </div>
  );
}
