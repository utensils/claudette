import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "./stores/useAppStore";
import { loadInitialData, getAppSetting, getHostEnvFlags, listRemoteConnections, listDiscoveredServers, getLocalServerStatus, detectInstalledApps, listSystemFonts, deleteTerminalTab, listAppSettingsWithPrefix } from "./services/tauri";
import { applyTheme, applyUserFonts, loadAllThemes, findTheme, cacheThemePreference, getThemeDataAttr } from "./utils/theme";
import { DEFAULT_THEME_ID, DEFAULT_LIGHT_THEME_ID } from "./styles/themes";
import type { ThemeDefinition } from "./types/theme";
import { adjustUiFontSize, resetUiFontSize } from "./utils/fontSettings";
import { KEYBINDING_SETTING_PREFIX } from "./hotkeys/bindings";
import { useMcpStatus } from "./hooks/useMcpStatus";
import { useViewTogglePersistence } from "./hooks/useViewTogglePersistence";
import { AppLayout } from "./components/layout/AppLayout";
import { findLeafByPtyId } from "./stores/terminalPaneTree";
import type { CommandEvent } from "./types";
import i18n, { isSupportedLanguage } from "./i18n";
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
  const setThemeMode = useAppStore((s) => s.setThemeMode);
  const setThemeDark = useAppStore((s) => s.setThemeDark);
  const setThemeLight = useAppStore((s) => s.setThemeLight);
  const setUiFontSize = useAppStore((s) => s.setUiFontSize);
  const setFontFamilySans = useAppStore((s) => s.setFontFamilySans);
  const setFontFamilyMono = useAppStore((s) => s.setFontFamilyMono);
  const setSystemFonts = useAppStore((s) => s.setSystemFonts);
  const setDetectedApps = useAppStore((s) => s.setDetectedApps);
  const setUsageInsightsEnabled = useAppStore((s) => s.setUsageInsightsEnabled);
  const setClaudetteTerminalEnabled = useAppStore((s) => s.setClaudetteTerminalEnabled);
  const setShowSidebarRunningCommands = useAppStore((s) => s.setShowSidebarRunningCommands);
  const setPluginManagementEnabled = useAppStore((s) => s.setPluginManagementEnabled);
  const setCommunityRegistryEnabled = useAppStore(
    (s) => s.setCommunityRegistryEnabled,
  );
  const setEditorGitGutterBase = useAppStore((s) => s.setEditorGitGutterBase);
  const setEditorMinimapEnabled = useAppStore((s) => s.setEditorMinimapEnabled);
  const setDisable1mContext = useAppStore((s) => s.setDisable1mContext);
  const setVoiceToggleHotkey = useAppStore((s) => s.setVoiceToggleHotkey);
  const setVoiceHoldHotkey = useAppStore((s) => s.setVoiceHoldHotkey);
  const setKeybindings = useAppStore((s) => s.setKeybindings);
  const setAppVersion = useAppStore((s) => s.setAppVersion);

  // Cached theme list — populated on initial load, reused by the OS handler.
  const loadedThemesRef = useRef<ThemeDefinition[]>([]);
  // Generation token: incremented on each OS theme change event so that a
  // stale async loadAllThemes() result doesn't overwrite a later handler's
  // applied theme when the OS toggles light↔dark in rapid succession.
  const themeChangeTokenRef = useRef(0);

  // Listen for MCP supervisor status events from the Rust backend.
  useMcpStatus();

  // Hydrate sidebar / panel visibility + sizes from app_settings on mount,
  // and write back when the user toggles or resizes anything. Without this
  // the user's preferred layout (e.g. right sidebar closed, terminal
  // hidden, custom widths) resets to the slice defaults on every restart.
  useViewTogglePersistence();

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
      // Hydrate SCM summaries from persisted cache for instant sidebar display.
      for (const row of data.scm_cache) {
        if (row.pr_json == null) continue;
        try {
          const parsed: unknown = JSON.parse(row.pr_json);
          const pr =
            parsed !== null &&
            typeof parsed === "object" &&
            "number" in parsed &&
            typeof (parsed as { number: unknown }).number === "number" &&
            "state" in parsed &&
            typeof (parsed as { state: unknown }).state === "string"
              ? (parsed as import("./types/plugin").PullRequest)
              : null;
          useAppStore.getState().setScmSummary(row.workspace_id, {
            hasPr: pr !== null,
            prState: pr?.state ?? null,
            ciState: pr?.ci_status ?? null,
            lastUpdated: new Date(row.fetched_at.replace(" ", "T") + "Z").getTime(),
          });
        } catch {
          // Corrupted cache entry — skip silently, will be refreshed by polling.
        }
      }
    });
    getAppSetting("terminal_font_size")
      .then((val) => {
        if (val) {
          const size = parseInt(val, 10);
          if (size >= 8 && size <= 24) setTerminalFontSize(size);
        }
      })
      .catch((err) => console.error("Failed to load terminal font size:", err));
    (async () => {
      try {
        const allThemes = await loadAllThemes();
        loadedThemesRef.current = allThemes;
        const [themeModeVal, darkIdVal, lightIdVal, legacyThemeVal] = await Promise.all([
          getAppSetting("theme_mode"),
          getAppSetting("theme_dark"),
          getAppSetting("theme_light"),
          getAppSetting("theme"),
        ]);
        const rawMode = themeModeVal ?? "dark";
        const mode: "light" | "dark" | "system" =
          rawMode === "light" || rawMode === "dark" || rawMode === "system"
            ? rawMode
            : "dark";
        // Resolve through findTheme so a previously-saved id that no longer
        // exists (e.g. a user JSON theme that was removed) falls back to a
        // real theme — and we persist that resolved id, not the dead one,
        // so the Settings <select> always reflects the applied theme.
        const darkTheme = findTheme(allThemes, darkIdVal ?? legacyThemeVal ?? DEFAULT_THEME_ID);
        const lightTheme = findTheme(allThemes, lightIdVal ?? DEFAULT_LIGHT_THEME_ID);
        const darkId = darkTheme.id;
        const lightId = lightTheme.id;

        setThemeMode(mode);
        setThemeDark(darkId);
        setThemeLight(lightId);

        const systemIsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        const effectiveId =
          mode === "system" ? (systemIsDark ? darkId : lightId) :
          mode === "light" ? lightId : darkId;

        const theme = findTheme(allThemes, effectiveId);
        setCurrentThemeId(theme.id);
        applyTheme(theme);

        // Cache per-mode attrs for the pre-hydration script.
        cacheThemePreference(mode, getThemeDataAttr(darkTheme), getThemeDataAttr(lightTheme));

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
      } catch (err) {
        console.error("Failed to load theme:", err);
      }
    })();
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
    getAppSetting("claudette_terminal_enabled")
      .then((val) => { if (val === "true") setClaudetteTerminalEnabled(true); })
      .catch(() => {});
    getAppSetting("show_sidebar_running_commands")
      .then((val) => { if (val === "true") setShowSidebarRunningCommands(true); })
      .catch(() => {});
    getAppSetting("plugin_management_enabled")
      .then((val) => { if (val === "true") setPluginManagementEnabled(true); })
      .catch(() => {});
    getAppSetting("community_registry_enabled")
      .then((val) => { if (val === "true") setCommunityRegistryEnabled(true); })
      .catch(() => {});
    getAppSetting("editor_git_gutter_base")
      .then((val) => {
        if (val === "merge_base") setEditorGitGutterBase("merge_base");
      })
      .catch(() => {});
    getAppSetting("editor_minimap_enabled")
      .then((val) => { if (val === "true") setEditorMinimapEnabled(true); })
      .catch(() => {});
    Promise.all([
      listAppSettingsWithPrefix(KEYBINDING_SETTING_PREFIX),
      getAppSetting("voice_toggle_hotkey"),
      getAppSetting("voice_hold_hotkey"),
    ])
      .then(([entries, legacyVoiceToggle, legacyVoiceHold]) => {
        if (legacyVoiceToggle === "disabled") setVoiceToggleHotkey(null);
        else if (legacyVoiceToggle) setVoiceToggleHotkey(legacyVoiceToggle);
        if (legacyVoiceHold === "disabled") setVoiceHoldHotkey(null);
        else if (legacyVoiceHold) setVoiceHoldHotkey(legacyVoiceHold);

        const bindings: Record<string, string | null> = {};
        for (const [key, value] of entries) {
          const actionId = key.slice(KEYBINDING_SETTING_PREFIX.length);
          bindings[actionId] = value === "disabled" ? null : value;
        }
        if (bindings["voice.toggle"] === undefined && legacyVoiceToggle) {
          bindings["voice.toggle"] =
            legacyVoiceToggle === "disabled" ? null : legacyVoiceToggle;
        }
        if (bindings["voice.hold"] === undefined && legacyVoiceHold) {
          bindings["voice.hold"] =
            legacyVoiceHold === "disabled" ? null : `code:${legacyVoiceHold}`;
        }
        setKeybindings(bindings);
      })
      .catch(() => {});
    getAppSetting("language")
      .then((lang) => {
        if (lang && isSupportedLanguage(lang) && lang !== i18n.language) {
          void i18n.changeLanguage(lang);
        }
      })
      .catch(() => {});
    getHostEnvFlags()
      .then(({ disable_1m_context }) => { if (disable_1m_context) setDisable1mContext(true); })
      .catch(() => {});

    // Listen for terminal command events. PTYs live on pane leaves inside
    // each tab's pane tree (a tab can hold multiple split panes, each with
    // its own PTY), so we walk the trees to find which tab owns the firing
    // PTY, then resolve that tab's workspace.
    const findWorkspaceForPty = (pty_id: number): string | null => {
      const { terminalTabs, terminalPaneTrees } = useAppStore.getState();
      for (const [wsId, tabs] of Object.entries(terminalTabs)) {
        for (const tab of tabs) {
          const tree = terminalPaneTrees[tab.id];
          if (tree && findLeafByPtyId(tree, pty_id)) return wsId;
        }
      }
      return null;
    };

    const setupCommandListeners = async () => {
      const unlistenCommandDetected = await listen<CommandEvent>("pty-command-detected", (event) => {
        const { pty_id, command } = event.payload;
        const wsId = findWorkspaceForPty(pty_id);
        if (!wsId) return;
        useAppStore.getState().setWorkspaceRunningCommand(wsId, pty_id, command || null);
      });

      const unlistenCommandStopped = await listen<CommandEvent>("pty-command-stopped", (event) => {
        const { pty_id } = event.payload;
        const wsId = findWorkspaceForPty(pty_id);
        if (!wsId) return;
        useAppStore.getState().clearWorkspaceRunningCommand(wsId, pty_id);
      });

      // Shell exited (e.g. user typed `exit`, or close_pty killed it): the
      // backend reader saw EOF and emitted pty-exit. Three things to do:
      //   1. Drop any running-command entry for this pty (so the sidebar
      //      indicator doesn't go stale). We search workspaceTerminalCommands
      //      directly because the tab/pane may already have been removed
      //      from the store if the user closed it via the X button — in
      //      that path the tab is removed before close_pty fires the EOF.
      //   2. If the pane is still in the tree, close it.
      //   3. If that was the only pane in its tab, close the tab too.
      const unlistenPtyExit = await listen<{ pty_id: number }>("pty-exit", (event) => {
        const ptyId = event.payload.pty_id;
        const {
          terminalTabs,
          terminalPaneTrees,
          workspaceTerminalCommands,
          closePane,
          removeTerminalTab,
          clearWorkspaceRunningCommand,
        } = useAppStore.getState();

        // 1. Sweep the workspaceTerminalCommands map for this pty across
        //    every workspace and clear any entry. Cheap (one outer-key
        //    scan) and works even when tabs/panes have already been
        //    cleaned up.
        for (const [wsId, ptyMap] of Object.entries(workspaceTerminalCommands)) {
          if (ptyId in ptyMap) {
            clearWorkspaceRunningCommand(wsId, ptyId);
          }
        }

        // 2. Try to find the owning pane and close it (handles the
        //    `exit`-typed-by-user case where the tab is still mounted).
        for (const [wsId, tabs] of Object.entries(terminalTabs)) {
          for (const tab of tabs) {
            const tree = terminalPaneTrees[tab.id];
            if (!tree) continue;
            const leaf = findLeafByPtyId(tree, ptyId);
            if (!leaf) continue;
            const remaining = closePane(tab.id, leaf.id);
            if (remaining === null) {
              deleteTerminalTab(tab.id).catch((err) =>
                console.error("Failed to delete terminal tab on exit:", err),
              );
              removeTerminalTab(wsId, tab.id);
            }
            return;
          }
        }
      });

      return () => {
        unlistenCommandDetected();
        unlistenCommandStopped();
        unlistenPtyExit();
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
      const wsId = event.payload;
      const store = useAppStore.getState();
      store.selectWorkspace(wsId);
      // The Rust tray click handler already cleared backend
      // `needs_attention` for every session in this workspace under a
      // single agents-write-lock. Only mirror that into the local cache —
      // do NOT fan out per-session `clearAttention` IPC calls. Those would
      // (a) duplicate the backend work O(session_count) times and (b) race
      // with any AskUserQuestion / ExitPlanMode that sets a fresh
      // `needs_attention=true` between the menu click and the loop, which
      // would silently swallow the new prompt.
      const sessions = store.sessionsByWorkspace[wsId] ?? [];
      for (const s of sessions) {
        if (s.status !== "Active") continue;
        if (!s.needs_attention && s.attention_kind === null) continue;
        store.updateChatSession(s.id, {
          needs_attention: false,
          attention_kind: null,
        });
      }
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

    // Listen for missing-CLI events (claude/git/gh not on PATH). Routes to the
    // MissingCliModal so users see platform-specific install guidance instead
    // of a raw subprocess error.
    const unlistenMissingCli = listen<import("./components/modals/MissingCliModal").MissingCliData>(
      "missing-dependency",
      (event) => {
        useAppStore.getState().openModal("missingCli", event.payload as unknown as Record<string, unknown>);
      },
    );

    // Listen for workspace auto-archived events (e.g. PR merged with archive_on_merge).
    // When `deleted` is true the workspace record was fully removed; otherwise it moved to Archived.
    const unlistenAutoArchived = listen<{ workspace_id: string; workspace_name: string; pr_number?: number; deleted?: boolean }>("workspace-auto-archived", (event) => {
      const { workspace_id, workspace_name, pr_number, deleted } = event.payload;
      const store = useAppStore.getState();
      if (deleted) {
        store.removeWorkspace(workspace_id);
      } else {
        store.updateWorkspace(workspace_id, { status: "Archived" as const });
      }
      if (store.selectedWorkspaceId === workspace_id) {
        store.selectWorkspace(null);
      }
      const msg = deleted
        ? pr_number != null
          ? i18n.t("sidebar:auto_deleted_merged", { name: workspace_name, prNumber: pr_number })
          : i18n.t("sidebar:auto_deleted_merged_nopr", { name: workspace_name })
        : pr_number != null
          ? i18n.t("sidebar:auto_archived_merged", { name: workspace_name, prNumber: pr_number })
          : i18n.t("sidebar:auto_archived_merged_nopr", { name: workspace_name });
      store.addToast(msg);
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
      unlistenMissingCli.then((fn) => fn());
    };
  }, [setRepositories, setWorkspaces, setWorktreeBaseDir, setDefaultBranches, setTerminalFontSize, setLastMessages, setRemoteConnections, setDiscoveredServers, setLocalServerRunning, setLocalServerConnectionString, setCurrentThemeId, setThemeMode, setThemeDark, setThemeLight, setUiFontSize, setFontFamilySans, setFontFamilyMono, setSystemFonts, setDetectedApps, setUsageInsightsEnabled, setClaudetteTerminalEnabled, setShowSidebarRunningCommands, setPluginManagementEnabled, setCommunityRegistryEnabled, setEditorGitGutterBase, setEditorMinimapEnabled, setDisable1mContext, setAppVersion, setVoiceToggleHotkey, setVoiceHoldHotkey, setKeybindings]);

  // Listen for OS light/dark changes and switch theme when mode is "system".
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = async (e: MediaQueryListEvent) => {
      const initial = useAppStore.getState();
      if (initial.themeMode !== "system") return;
      const token = ++themeChangeTokenRef.current;
      // Tentative — only used to decide whether to refresh the theme cache.
      // The authoritative effectiveId is recomputed from fresh state below.
      const tentativeId = e.matches ? initial.themeDark : initial.themeLight;
      // The cached theme list is populated once on initial load. If the user
      // dropped a new JSON theme on disk and selected it via Settings, it
      // won't be in the ref — refresh on miss so we apply the right theme
      // instead of silently falling back via findTheme.
      let themes = loadedThemesRef.current;
      if (!themes.some((t) => t.id === tentativeId)) {
        try {
          themes = await loadAllThemes();
          loadedThemesRef.current = themes;
        } catch (err) {
          console.error("Failed to reload themes for system change:", err);
        }
      }
      // A later OS event already ran — discard this stale result.
      if (themeChangeTokenRef.current !== token) return;
      // Re-read store state: the user may have switched away from system mode
      // (or changed themeDark/themeLight, fonts, etc.) during the await. If
      // they did, their explicit action already applied a theme synchronously
      // and we must not stomp it.
      const fresh = useAppStore.getState();
      if (fresh.themeMode !== "system") return;
      if (themes.length === 0) return;
      const effectiveId = e.matches ? fresh.themeDark : fresh.themeLight;
      try {
        const theme = findTheme(themes, effectiveId);
        applyTheme(theme);
        applyUserFonts(fresh.fontFamilySans, fresh.fontFamilyMono, fresh.uiFontSize);
        fresh.setCurrentThemeId(theme.id);
      } catch (err) {
        console.error("Failed to apply system theme change:", err);
      }
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", handleChange);
      return () => mq.removeEventListener("change", handleChange);
    }
    // Fallback for older WebKit (e.g. macOS Catalina / Safari <14)
    mq.addListener(handleChange);
    return () => mq.removeListener(handleChange);
  }, []);

  return <AppLayout />;
}

export default App;
