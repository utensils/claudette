import { useState } from "react";
import { ChatListScreen } from "./screens/ChatListScreen";
import { ConnectScreen } from "./screens/ConnectScreen";
import { WorkspacesScreen } from "./screens/WorkspacesScreen";
import type { ChatSession, SavedConnection, Workspace } from "./types";

type View =
  | { kind: "connect" }
  | { kind: "workspaces"; connection: SavedConnection }
  | {
      kind: "chat-list";
      connection: SavedConnection;
      workspace: Workspace;
    }
  | {
      kind: "chat";
      connection: SavedConnection;
      workspace: Workspace;
      session: ChatSession;
    };

// Phase 6: pair → workspaces → chat list. Phase 7 fills in the actual
// `kind: "chat"` view (streaming, composer); for now it falls back to
// a "Coming soon" placeholder so the navigation flow is fully wired.

export function App() {
  const [view, setView] = useState<View>({ kind: "connect" });

  switch (view.kind) {
    case "connect":
      return (
        <ConnectScreen
          onConnected={(connection) =>
            setView({ kind: "workspaces", connection })
          }
        />
      );
    case "workspaces":
      return (
        <WorkspacesScreen
          connection={view.connection}
          onOpenWorkspace={(workspace) =>
            setView({
              kind: "chat-list",
              connection: view.connection,
              workspace,
            })
          }
          onDisconnect={() => setView({ kind: "connect" })}
        />
      );
    case "chat-list":
      return (
        <ChatListScreen
          connection={view.connection}
          workspace={view.workspace}
          onOpenSession={(session) =>
            setView({
              kind: "chat",
              connection: view.connection,
              workspace: view.workspace,
              session,
            })
          }
          onBack={() =>
            setView({ kind: "workspaces", connection: view.connection })
          }
        />
      );
    case "chat":
      return (
        <div className="shell">
          <header className="header header-row">
            <button
              className="ghost-btn"
              onClick={() =>
                setView({
                  kind: "chat-list",
                  connection: view.connection,
                  workspace: view.workspace,
                })
              }
            >
              ← Back
            </button>
            <div className="header-center">
              <h1>{view.session.name ?? "Session"}</h1>
              <p className="subtitle">{view.workspace.name}</p>
            </div>
          </header>
          <main className="main">
            <p className="status">
              Streaming chat UI ships in Phase 7. Session id:{" "}
              <code>{view.session.id}</code>
            </p>
          </main>
        </div>
      );
  }
}
