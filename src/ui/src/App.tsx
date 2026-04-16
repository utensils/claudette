import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "./stores/useAppStore";
import { loadInitialData, getAppSetting, listRemoteConnections, listDiscoveredServers, getLocalServerStatus, clearAttention, detectInstalledApps, listSystemFonts } from "./services/tauri";
import { applyTheme, applyUserFonts, loadAllThemes, findTheme } from "./utils/theme";
import { adjustUiFontSize, resetUiFontSize } from "./utils/fontSettings";
import { useMcpStatus } from "./hooks/useMcpStatus";
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
  const setUiFontSize = useAppStore((s) => s.setUiFontSize);
  const setFontFamilySans = useAppStore((s) => s.setFontFamilySans);
  const setFontFamilyMono = useAppStore((s) => s.setFontFamilyMono);
  const setSystemFonts = useAppStore((s) => s.setSystemFonts);
  const setDetectedApps = useAppStore((s) => s.setDetectedApps);
  const setUsageInsightsEnabled = useAppStore((s) => s.setUsageInsightsEnabled);
  const setPluginManagementEnabled = useAppStore((s) => s.setPluginManagementEnabled);
  const setAppVersion = useAppStore((s) => s.setAppVersion);

  // Listen for MCP supervisor status events from the Rust backend.
  useMcpStatus();

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
        // Apply user font overrides on top of the theme.
        const [sansVal, monoVal, sizeVal] = await Promise.all([
          getAppSetting("font_family_sans"),
          getAppSetting("font_family_mono"),
          getAppSetting("ui_font_size"),
        ]);
        const sans = sansVal ?? "";
        const mono = monoVal ?? "";
        const size = sizeVal ? parseInt(sizeVal, 10) : 13;
        if (sans) setFontFamilySans(sans);
        if (mono) setFontFamilyMono(mono);
        if (sizeVal && size >= 10 && size <= 20) setUiFontSize(size);
        applyUserFonts(sans, mono, size >= 10 && size <= 20 ? size : 13);
      })
      .catch((err) => console.error("Failed to load theme:", err));
    getVersion()
      .then((v) => setAppVersion(v))
      .catch((err) => console.error("Failed to load app version:", err));
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

    listSystemFonts()
      .then(setSystemFonts)
      .catch((err) => console.error("Failed to list system fonts:", err));

    getAppSetting("usage_insights_enabled")
      .then((val) => { if (val === "true") setUsageInsightsEnabled(true); })
      .catch(() => {});
    getAppSetting("plugin_management_enabled")
      .then((val) => { if (val === "true") setPluginManagementEnabled(true); })
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

    // Listen for zoom events from the View menu.
    const unlistenZoomIn = listen("zoom-in", () => adjustUiFontSize(+1));
    const unlistenZoomOut = listen("zoom-out", () => adjustUiFontSize(-1));
    const unlistenResetZoom = listen("reset-zoom", () => resetUiFontSize());

    // Listen for background SCM polling updates.
    const unlistenScmUpdate = listen<import("./types/plugin").ScmDetail>("scm-data-updated", (event) => {
      const detail = event.payload;
      const store = useAppStore.getState();
      // Update summary for sidebar badges
      store.setScmSummary(detail.workspace_id, {
        hasPr: detail.pull_request !== null,
        prState: detail.pull_request?.state ?? null,
        ciState: detail.pull_request?.ci_status ?? null,
        lastUpdated: Date.now(),
      });
      // Update detail if this is the selected workspace
      if (store.selectedWorkspaceId === detail.workspace_id) {
        store.setScmDetail(detail);
      }
    });

    // Listen for workspace auto-archived events (e.g. PR merged with archive_on_merge).
    const unlistenAutoArchived = listen<{ workspace_id: string; workspace_name: string }>("workspace-auto-archived", (event) => {
      const { workspace_id } = event.payload;
      const store = useAppStore.getState();
      store.updateWorkspace(workspace_id, { status: "Archived" as const });
      // If the archived workspace was selected, deselect it
      if (store.selectedWorkspaceId === workspace_id) {
        store.selectWorkspace(null);
      }
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
      unlistenZoomIn.then((fn) => fn());
      unlistenZoomOut.then((fn) => fn());
      unlistenResetZoom.then((fn) => fn());
      unlistenScmUpdate.then((fn) => fn());
      unlistenAutoArchived.then((fn) => fn());
    };
  }, [setRepositories, setWorkspaces, setWorktreeBaseDir, setDefaultBranches, setTerminalFontSize, setLastMessages, setRemoteConnections, setDiscoveredServers, setLocalServerRunning, setLocalServerConnectionString, setCurrentThemeId, setUiFontSize, setFontFamilySans, setFontFamilyMono, setSystemFonts, setDetectedApps, setUsageInsightsEnabled, setPluginManagementEnabled, setAppVersion]);

  return <AppLayout />;
}

export default App;
