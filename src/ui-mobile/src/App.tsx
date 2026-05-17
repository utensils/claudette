import { useState } from "react";
import { ChatListScreen } from "./screens/ChatListScreen";
import { ChatScreen } from "./screens/ChatScreen";
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

// Top-level navigation: connect → workspaces → chat list → chat. The
// chat view (streaming, composer, AskUserQuestion sheet, plan approval
// card) routes through `ChatScreen` below.

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
        <ChatScreen
          connection={view.connection}
          workspace={view.workspace}
          session={view.session}
          onBack={() =>
            setView({
              kind: "chat-list",
              connection: view.connection,
              workspace: view.workspace,
            })
          }
        />
      );
  }
}
