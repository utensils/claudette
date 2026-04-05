import { useEffect } from "react";
import { useAppStore } from "./stores/useAppStore";
import { loadInitialData, getAppSetting, listRemoteConnections, listDiscoveredServers } from "./services/tauri";
import { AppLayout } from "./components/layout/AppLayout";
import "./styles/theme.css";

function App() {
  const setRepositories = useAppStore((s) => s.setRepositories);
  const setWorkspaces = useAppStore((s) => s.setWorkspaces);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);
  const setDefaultBranches = useAppStore((s) => s.setDefaultBranches);
  const setTerminalFontSize = useAppStore((s) => s.setTerminalFontSize);
  const setLastMessages = useAppStore((s) => s.setLastMessages);
  const setRemoteConnections = useAppStore((s) => s.setRemoteConnections);
  const setDiscoveredServers = useAppStore((s) => s.setDiscoveredServers);

  useEffect(() => {
    loadInitialData().then((data) => {
      setRepositories(data.repositories);
      setWorkspaces(data.workspaces);
      setWorktreeBaseDir(data.worktree_base_dir);
      setDefaultBranches(data.default_branches);
      // Index last messages by workspace_id for dashboard display.
      const msgMap: Record<string, (typeof data.last_messages)[0]> = {};
      for (const msg of data.last_messages) {
        msgMap[msg.workspace_id] = msg;
      }
      setLastMessages(msgMap);
    });
    getAppSetting("terminal_font_size")
      .then((val) => {
        if (val) {
          const size = parseInt(val, 10);
          if (size >= 8 && size <= 24) setTerminalFontSize(size);
        }
      })
      .catch((err) => console.error("Failed to load terminal font size:", err));
    listRemoteConnections()
      .then(setRemoteConnections)
      .catch((err) => console.error("Failed to load remote connections:", err));
    listDiscoveredServers()
      .then(setDiscoveredServers)
      .catch((err) => console.error("Failed to load discovered servers:", err));
  }, [setRepositories, setWorkspaces, setWorktreeBaseDir, setDefaultBranches, setTerminalFontSize, setLastMessages, setRemoteConnections, setDiscoveredServers]);

  return <AppLayout />;
}

export default App;
