import { useEffect } from "react";
import { useAppStore } from "./stores/useAppStore";
import { loadInitialData, getAppSetting, listRemoteConnections, listDiscoveredServers, getLocalServerStatus } from "./services/tauri";
import { applyTheme, loadAllThemes, findTheme } from "./utils/theme";
import { AppLayout } from "./components/layout/AppLayout";
import "./styles/theme.css";

function App() {
  const setRepositories = useAppStore((s) => s.setRepositories);
  const setWorkspaces = useAppStore((s) => s.setWorkspaces);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);
  const setDefaultBranches = useAppStore((s) => s.setDefaultBranches);
  const setTerminalFontSize = useAppStore((s) => s.setTerminalFontSize);
  const setAudioNotifications = useAppStore((s) => s.setAudioNotifications);
  const setLastMessages = useAppStore((s) => s.setLastMessages);
  const setRemoteConnections = useAppStore((s) => s.setRemoteConnections);
  const setDiscoveredServers = useAppStore((s) => s.setDiscoveredServers);
  const setLocalServerRunning = useAppStore((s) => s.setLocalServerRunning);
  const setLocalServerConnectionString = useAppStore((s) => s.setLocalServerConnectionString);
  const setCurrentThemeId = useAppStore((s) => s.setCurrentThemeId);

  useEffect(() => {
    loadInitialData().then((data) => {
      // Tag local data with null remote_connection_id (backend omits this field).
      setRepositories(
        data.repositories.map((r) => ({ ...r, remote_connection_id: null }))
      );
      setWorkspaces(
        data.workspaces.map((w) => ({ ...w, remote_connection_id: null }))
      );
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
    getAppSetting("audio_notifications")
      .then((val) => {
        if (val === "true") setAudioNotifications(true);
      })
      .catch((err) => console.error("Failed to load audio notifications setting:", err));
    getAppSetting("theme")
      .then(async (savedThemeId) => {
        const allThemes = await loadAllThemes();
        const theme = findTheme(allThemes, savedThemeId ?? "default-dark");
        setCurrentThemeId(theme.id);
        applyTheme(theme);
      })
      .catch((err) => console.error("Failed to load theme:", err));
    listRemoteConnections()
      .then(setRemoteConnections)
      .catch((err) => console.error("Failed to load remote connections:", err));
    // Poll discovered servers every 5s so the Nearby list stays current.
    const refreshDiscoveredServers = () => {
      listDiscoveredServers()
        .then(setDiscoveredServers)
        .catch((err) => console.error("Failed to load discovered servers:", err));
    };
    refreshDiscoveredServers();
    const discoveredServersPollId = window.setInterval(refreshDiscoveredServers, 5000);

    getLocalServerStatus()
      .then((info) => {
        setLocalServerRunning(info.running);
        setLocalServerConnectionString(info.connection_string);
      })
      .catch((err) => console.error("Failed to load local server status:", err));

    return () => {
      window.clearInterval(discoveredServersPollId);
    };
  }, [setRepositories, setWorkspaces, setWorktreeBaseDir, setDefaultBranches, setTerminalFontSize, setLastMessages, setRemoteConnections, setDiscoveredServers, setLocalServerRunning, setLocalServerConnectionString, setCurrentThemeId]);

  return <AppLayout />;
}

export default App;
