import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "./stores/useAppStore";
import { loadInitialData, getAppSetting, listRemoteConnections, listDiscoveredServers, getLocalServerStatus, clearAttention, detectInstalledApps } from "./services/tauri";
import { applyTheme, loadAllThemes, findTheme } from "./utils/theme";
import { AppLayout } from "./components/layout/AppLayout";
import type { CommandEvent } from "./types";
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
  const setLocalServerRunning = useAppStore((s) => s.setLocalServerRunning);
  const setLocalServerConnectionString = useAppStore((s) => s.setLocalServerConnectionString);
  const setCurrentThemeId = useAppStore((s) => s.setCurrentThemeId);
  const setDetectedApps = useAppStore((s) => s.setDetectedApps);
  const setUsageInsightsEnabled = useAppStore((s) => s.setUsageInsightsEnabled);

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

    detectInstalledApps()
      .then(setDetectedApps)
      .catch((err) => console.error("Failed to detect installed apps:", err));

    getAppSetting("usage_insights_enabled")
      .then((val) => { if (val === "true") setUsageInsightsEnabled(true); })
      .catch(() => {});

    // Listen for terminal command events
    const setupCommandListeners = async () => {
      const unlistenCommandDetected = await listen<CommandEvent>("pty-command-detected", (event) => {
        const { pty_id, command } = event.payload;

        // Find the workspace that owns this PTY - use getState() to avoid stale closure
        const { terminalTabs, setWorkspaceTerminalCommand } = useAppStore.getState();
        for (const [wsId, tabs] of Object.entries(terminalTabs)) {
          const tab = tabs.find((t) => t.pty_id === pty_id);
          if (tab) {
            setWorkspaceTerminalCommand(wsId, {
              command: command || null,
              isRunning: true,
              exitCode: null,
            });
            break;
          }
        }
      });

      const unlistenCommandStopped = await listen<CommandEvent>("pty-command-stopped", (event) => {
        const { pty_id, command, exit_code } = event.payload;

        // Find the workspace that owns this PTY - use getState() to avoid stale closure
        const { terminalTabs, setWorkspaceTerminalCommand } = useAppStore.getState();
        for (const [wsId, tabs] of Object.entries(terminalTabs)) {
          const tab = tabs.find((t) => t.pty_id === pty_id);
          if (tab) {
            setWorkspaceTerminalCommand(wsId, {
              command: command || null,
              isRunning: false,
              exitCode: exit_code !== null && exit_code !== undefined ? exit_code : null,
            });
            break;
          }
        }
      });

      return () => {
        unlistenCommandDetected();
        unlistenCommandStopped();
      };
    };

    let isActive = true;
    const unlistenCommandEventsPromise = setupCommandListeners();

    // If the promise resolves after cleanup, call unlisten immediately
    unlistenCommandEventsPromise.then((unlisten) => {
      if (!isActive) {
        unlisten();
      }
    });

    // Listen for tray workspace selection events.
    const unlistenTray = listen<string>("tray-select-workspace", (event) => {
      useAppStore.getState().selectWorkspace(event.payload);
      clearAttention(event.payload).catch(() => {});
    });

    // Listen for open-settings events from app menu / tray.
    const unlistenSettings = listen("open-settings", () => {
      useAppStore.getState().openSettings();
    });

    return () => {
      isActive = false;
      window.clearInterval(discoveredServersPollId);
      // Clean up listeners when they're ready
      void unlistenCommandEventsPromise.then((unlisten) => {
        unlisten();
      });
      unlistenTray.then((fn) => fn());
      unlistenSettings.then((fn) => fn());
    };
  }, [setRepositories, setWorkspaces, setWorktreeBaseDir, setDefaultBranches, setTerminalFontSize, setLastMessages, setRemoteConnections, setDiscoveredServers, setLocalServerRunning, setLocalServerConnectionString, setCurrentThemeId, setDetectedApps, setUsageInsightsEnabled]);

  return <AppLayout />;
}

export default App;
