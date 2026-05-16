import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "./stores/useAppStore";
import { findPendingPlaceholderForCreatedWorkspace } from "./stores/slices/workspacesSlice";
import { loadInitialData, getAppSetting, setAppSetting, getHostEnvFlags, listRemoteConnections, listDiscoveredServers, getLocalServerStatus, detectInstalledApps, listSystemFonts, deleteTerminalTab, listAppSettingsWithPrefix, listAgentBackends, autoDetectAgentBackends, refreshAgentBackendModels, bootOk, getClaudeAuthStatus } from "./services/tauri";
import { applyTheme, applyUserFonts, loadAllThemes, findTheme, cacheThemePreference, getThemeDataAttr } from "./utils/theme";
import { DEFAULT_THEME_ID, DEFAULT_LIGHT_THEME_ID } from "./styles/themes";
import type { ThemeDefinition } from "./types/theme";
import {
  adjustUiFontSize,
  resetUiFontSize,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
} from "./utils/fontSettings";
import { deriveScmCiState } from "./utils/scmChecks";
import { KEYBINDING_SETTING_PREFIX } from "./hotkeys/bindings";
import type { WorkspaceOrderModeByRepo } from "./utils/workspaceOrdering";
import { useMcpStatus } from "./hooks/useMcpStatus";
import { useChatSessionCreatedEvent } from "./hooks/useChatSessionCreatedEvent";
import { useUsageInsightsPoller } from "./hooks/useUsageInsightsPoller";
import {
  hydratePersistedViewState,
  useViewTogglePersistence,
} from "./hooks/useViewTogglePersistence";
import { AppLayout } from "./components/layout/AppLayout";
import {
  FIRST_CLASS_BACKENDS_PROMOTION_KEY,
  planBackendGateLoadFromResults,
} from "./components/settings/codexBackendMigration";
import { autoDetectStartupAgentBackends } from "./components/settings/agentBackendStartupRefresh";
import { findLeafByPtyId } from "./stores/terminalPaneTree";
import type { CommandEvent } from "./types";
import i18n, { isSupportedLanguage } from "./i18n";
import "./styles/theme.css";

function workspaceOrderModesFromRepoIds(
  repoIds: readonly string[],
): WorkspaceOrderModeByRepo {
  const modes: WorkspaceOrderModeByRepo = {};
  for (const repoId of repoIds) {
    modes[repoId] = "manual";
  }
  return modes;
}

function App() {
  const setRepositories = useAppStore((s) => s.setRepositories);
  const setWorkspaces = useAppStore((s) => s.setWorkspaces);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);
  const setDefaultTerminalAppId = useAppStore((s) => s.setDefaultTerminalAppId);
  const setWorkspaceAppsMenuShown = useAppStore(
    (s) => s.setWorkspaceAppsMenuShown,
  );
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
  const setToolDisplayMode = useAppStore((s) => s.setToolDisplayMode);
  const setExtendedToolCallOutput = useAppStore((s) => s.setExtendedToolCallOutput);
  const setPluginManagementEnabled = useAppStore((s) => s.setPluginManagementEnabled);
  const setClaudeRemoteControlEnabled = useAppStore(
    (s) => s.setClaudeRemoteControlEnabled,
  );
  const setCommunityRegistryEnabled = useAppStore(
    (s) => s.setCommunityRegistryEnabled,
  );
  const setEditorGitGutterBase = useAppStore((s) => s.setEditorGitGutterBase);
  const setEditorMinimapEnabled = useAppStore((s) => s.setEditorMinimapEnabled);
  const setEditorWordWrap = useAppStore((s) => s.setEditorWordWrap);
  const setEditorLineNumbersEnabled = useAppStore(
    (s) => s.setEditorLineNumbersEnabled,
  );
  const setEditorFontZoom = useAppStore((s) => s.setEditorFontZoom);
  const setDisable1mContext = useAppStore((s) => s.setDisable1mContext);
  const setAlternativeBackendsAvailable = useAppStore((s) => s.setAlternativeBackendsAvailable);
  const setPiSdkAvailable = useAppStore((s) => s.setPiSdkAvailable);
  const setAlternativeBackendsEnabled = useAppStore((s) => s.setAlternativeBackendsEnabled);
  const setCodexEnabled = useAppStore((s) => s.setCodexEnabled);
  const setAgentBackends = useAppStore((s) => s.setAgentBackends);
  const setDefaultAgentBackendId = useAppStore((s) => s.setDefaultAgentBackendId);
  const setClaudeAuthMethod = useAppStore((s) => s.setClaudeAuthMethod);
  // Read for the LM Studio polling effect below. We deliberately do
  // *not* subscribe to `agentBackends` here — the polling tick reads
  // the live list via `useAppStore.getState()` so we don't tear the
  // interval down whenever the list updates.
  const alternativeBackendsEnabled = useAppStore(
    (s) => s.alternativeBackendsEnabled,
  );
  const setVoiceToggleHotkey = useAppStore((s) => s.setVoiceToggleHotkey);
  const setVoiceHoldHotkey = useAppStore((s) => s.setVoiceHoldHotkey);
  const setKeybindings = useAppStore((s) => s.setKeybindings);
  const setAppVersion = useAppStore((s) => s.setAppVersion);
  const setManualWorkspaceOrderByRepo = useAppStore(
    (s) => s.setManualWorkspaceOrderByRepo,
  );
  const [viewStateHydrated, setViewStateHydrated] = useState(false);
  // Separate flag for the boot-health heartbeat: only flips on the
  // *success* path of loadInitialData. The viewStateHydrated flag is
  // also set in the catch() branch so the UI can render a recovery
  // shell on a broken DB / migration / persisted-state load — but
  // those failures are *exactly* the class of regression Gate 2 is
  // supposed to roll back, so we must not ack on that path.
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);

  // Cached theme list — populated on initial load, reused by the OS handler.
  const loadedThemesRef = useRef<ThemeDefinition[]>([]);
  // Generation token: incremented on each OS theme change event so that a
  // stale async loadAllThemes() result doesn't overwrite a later handler's
  // applied theme when the OS toggles light↔dark in rapid succession.
  const themeChangeTokenRef = useRef(0);

  // Listen for MCP supervisor status events from the Rust backend.
  useMcpStatus();
  useChatSessionCreatedEvent();
  useUsageInsightsPoller();

  // Boot-health heartbeat for the post-update probation window.
  //
  // Two conditions must both hold before we ack:
  //   1. `viewStateHydrated` — React has committed past the loader
  //      (this gates the early `return null` below). A module-eval
  //      crash in AppLayout's import graph would never flip this.
  //   2. `initialDataLoaded` — the `.then()` branch of
  //      `loadInitialData` resolved. The `.catch()` branch *also*
  //      flips `viewStateHydrated` so the UI can render even when
  //      the DB load fails, but a broken migration / corrupt persisted
  //      state / DB lock is exactly the failure mode Gate 2 is meant
  //      to roll back. Gating on `initialDataLoaded` keeps those
  //      paths from accidentally marking the broken build healthy.
  //
  // See GitHub issue 731 for the design intent — "first paint of any
  // non-error-boundary route".
  useEffect(() => {
    if (!viewStateHydrated || !initialDataLoaded) return;
    bootOk().catch((err) => console.error("Failed to acknowledge boot:", err));
  }, [viewStateHydrated, initialDataLoaded]);

  // Hydrate persisted view state after workspaces are loaded, then write back
  // future layout, selection, tab, and terminal-view changes.
  useViewTogglePersistence(viewStateHydrated);

  useEffect(() => {
    loadInitialData()
      .then(async (data) => {
        // Tag local data with null remote_connection_id (backend omits this field).
        const localWorkspaces = data.workspaces.map((w) => ({
          ...w,
          remote_connection_id: null,
        }));
        setRepositories(
          data.repositories.map((r) => ({ ...r, remote_connection_id: null }))
        );
        setWorkspaces(localWorkspaces);
        setManualWorkspaceOrderByRepo(
          workspaceOrderModesFromRepoIds(data.manual_workspace_order_repo_ids),
        );
        setWorktreeBaseDir(data.worktree_base_dir);
        setDefaultBranches(data.default_branches);
        // Index last messages by workspace_id for dashboard display.
        const msgMap: Record<string, (typeof data.last_messages)[0]> = {};
        for (const msg of data.last_messages) {
          msgMap[msg.workspace_id] = msg;
        }
        setLastMessages(msgMap);
        await hydratePersistedViewState(localWorkspaces);
        setViewStateHydrated(true);
        // Boot-health gate: only ack on the success path. The
        // `.catch()` branch below also flips `viewStateHydrated` so
        // the UI can recover, but a failed initial data load is
        // exactly the kind of regression we want the rollback to
        // catch — see the comment on the `bootOk` useEffect above.
        setInitialDataLoaded(true);
        // Hydrate SCM summaries and detail from persisted cache so sidebar
        // badges and the PR banner show instantly without a network call.
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
            const parsedChecks: unknown = row.ci_json ? JSON.parse(row.ci_json) : [];
            const checks = Array.isArray(parsedChecks)
              ? (parsedChecks as import("./types/plugin").CiCheck[])
              : [];
            const store = useAppStore.getState();
            store.setScmSummary(row.workspace_id, {
              hasPr: pr !== null,
              prState: pr?.state ?? null,
              ciState: pr ? deriveScmCiState(pr.ci_status, checks) : null,
              lastUpdated: new Date(row.fetched_at.replace(" ", "T") + "Z").getTime(),
            });
            // Also seed the per-workspace detail map so selecting any workspace
            // shows the PR banner immediately instead of waiting for a fetch.
            if (pr) {
              store.setScmDetail({
                workspace_id: row.workspace_id,
                pull_request: pr,
                ci_checks: checks,
                provider: row.provider ?? null,
                error: row.error ?? null,
              });
            }
          } catch {
            // Corrupted cache entry — skip silently, will be refreshed by polling.
          }
        }
      })
      .catch(async (err) => {
        console.error("Failed to load initial data:", err);
        await hydratePersistedViewState([]);
        setViewStateHydrated(true);
      });
    getAppSetting("terminal_font_size")
      .then((val) => {
        if (val) {
          const size = parseInt(val, 10);
          if (size >= TERMINAL_FONT_SIZE_MIN && size <= TERMINAL_FONT_SIZE_MAX) {
            setTerminalFontSize(size);
          }
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
    // One-shot probe for native file-picker availability. On Linux
    // without xdg-desktop-portal, Tauri's dialog plugin panics from
    // the Rust side — components consult this to hide Browse
    // buttons rather than gambling on a crash.
    useAppStore.getState().fetchFileDialogCapability();
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
    getAppSetting("default_terminal_app_id")
      .then((val) => setDefaultTerminalAppId(val && val.trim() ? val : null))
      .catch(() => {});
    getAppSetting("workspace_apps_menu")
      .then((val) => {
        if (!val) return;
        try {
          const parsed: unknown = JSON.parse(val);
          const shown =
            parsed && typeof parsed === "object" && "shown" in parsed
              ? (parsed as { shown: unknown }).shown
              : undefined;
          if (Array.isArray(shown)) {
            setWorkspaceAppsMenuShown(
              shown.filter((x): x is string => typeof x === "string"),
            );
          }
        } catch {
          /* ignore malformed value — fall back to "show all" */
        }
      })
      .catch(() => {});

    listSystemFonts()
      .then(setSystemFonts)
      .catch((err) => console.error("Failed to list system fonts:", err));

    getAppSetting("usage_insights_enabled")
      .then((val) => { if (val === "true") setUsageInsightsEnabled(true); })
      .catch(() => {});
    getAppSetting("claudette_terminal_enabled")
      .then((val) => {
        // Default ON: only an explicit "false" disables. Absent / any other
        // value leaves the store at its `true` initial value.
        if (val === "false") setClaudetteTerminalEnabled(false);
      })
      .catch(() => {});
    getAppSetting("show_sidebar_running_commands")
      .then((val) => { if (val === "true") setShowSidebarRunningCommands(true); })
      .catch(() => {});
    getAppSetting("tool_display_mode")
      .then((val) => {
        if (val === "inline" || val === "grouped") setToolDisplayMode(val);
      })
      .catch(() => {});
    getAppSetting("extended_tool_call_output")
      .then((val) => { if (val === "true") setExtendedToolCallOutput(true); })
      .catch(() => {});
    getAppSetting("plugin_management_enabled")
      .then((val) => { if (val === "true") setPluginManagementEnabled(true); })
      .catch(() => {});
    getAppSetting("claude_remote_control_enabled")
      .then((val) => {
        if (val === "false") setClaudeRemoteControlEnabled(false);
        else setClaudeRemoteControlEnabled(true);
      })
      .catch(() => {});
    getAppSetting("community_registry_enabled")
      .then((val) => { if (val === "true") setCommunityRegistryEnabled(true); })
      .catch(() => {});
    Promise.allSettled([
      getAppSetting("alternative_backends_enabled"),
      getAppSetting("codex_enabled"),
      getAppSetting("experimental_codex_enabled"),
      getAppSetting(FIRST_CLASS_BACKENDS_PROMOTION_KEY),
      getHostEnvFlags(),
    ])
      .then(async ([settingResult, codexSettingResult, legacyCodexSettingResult, promotionResult, flagsResult]) => {
        const flags =
          flagsResult.status === "fulfilled"
            ? flagsResult.value
            : { alternative_backends_compiled: false, disable_1m_context: false, pi_sdk_compiled: false };
        if (flagsResult.status === "rejected") {
          console.error("Failed to load host environment flags:", flagsResult.reason);
        }
        setAlternativeBackendsAvailable(flags.alternative_backends_compiled);
        setPiSdkAvailable(flags.pi_sdk_compiled);
        if (flags.disable_1m_context) setDisable1mContext(true);
        if (settingResult.status === "rejected") {
          console.error("Failed to load alternative backend setting:", settingResult.reason);
        }
        if (codexSettingResult.status === "rejected") {
          console.error("Failed to load Codex setting:", codexSettingResult.reason);
        }
        if (legacyCodexSettingResult.status === "rejected") {
          console.error("Failed to load legacy Codex setting:", legacyCodexSettingResult.reason);
        }
        if (promotionResult.status === "rejected") {
          console.error("Failed to load backend promotion setting:", promotionResult.reason);
        }
        const gatePlan = planBackendGateLoadFromResults({
          alternativeBackendsCompiled: flags.alternative_backends_compiled,
          alternativeBackendsSetting: settingResult,
          codexSetting:
            codexSettingResult.status === "fulfilled" && codexSettingResult.value !== null
              ? codexSettingResult
              : legacyCodexSettingResult.status === "fulfilled"
                ? legacyCodexSettingResult
                : codexSettingResult,
          promotionSetting: promotionResult,
        });
        if (!gatePlan) return;
        setAlternativeBackendsEnabled(gatePlan.alternativeBackendsEnabled);
        setCodexEnabled(gatePlan.codexEnabled);
        if (gatePlan.shouldPersistPromotion) {
          await Promise.all([
            setAppSetting("alternative_backends_enabled", "true"),
            setAppSetting("codex_enabled", "true"),
            setAppSetting(FIRST_CLASS_BACKENDS_PROMOTION_KEY, "true"),
          ]);
        }
      })
      .catch((err) => {
        console.error("Failed to load backend gate settings:", err);
      });
    listAgentBackends()
      .then((data) => {
        setAgentBackends(data.backends);
        setDefaultAgentBackendId(data.default_backend_id);
        void autoDetectStartupAgentBackends({
          backends: data.backends,
          autoDetectBackends: autoDetectAgentBackends,
          onBackends: setAgentBackends,
          onDefaultBackend: setDefaultAgentBackendId,
          onError: (error) => {
            console.warn("Startup provider auto-detection failed:", error);
          },
        });
      })
      .catch(() => {});
    // Seed the Claude auth method so the model picker can hide
    // Pi/anthropic/* for OAuth subscription users on first paint. The
    // probe is a single `claude auth status --json` call with a tight
    // timeout, gated to startup; live updates come from
    // ClaudeCodeAuthSetting when the user logs in/out from Settings.
    //
    // `quiet: true` keeps the missing-CLI dialog from firing on launch
    // for users who don't have the Claude CLI installed — they should
    // be able to use Pi or Codex without being prompted about Claude.
    // `loggedIn ? authMethod : null` mirrors ClaudeCodeAuthSetting: an
    // `auth_method` returned alongside `loggedIn: false` is meaningless
    // history, not a current subscription state, so flatten it.
    getClaudeAuthStatus(false, { quiet: true })
      .then((status) =>
        setClaudeAuthMethod(status.loggedIn ? status.authMethod : null),
      )
      .catch(() => setClaudeAuthMethod(null));
    getAppSetting("editor_git_gutter_base")
      .then((val) => {
        if (val === "merge_base") setEditorGitGutterBase("merge_base");
      })
      .catch(() => {});
    getAppSetting("editor_minimap_enabled")
      .then((val) => { if (val === "true") setEditorMinimapEnabled(true); })
      .catch(() => {});
    // Editor view-state mirrors the minimap pattern: stored as strings
    // in app_settings, hydrated once at boot. Word wrap and line numbers
    // default to enabled, so we only flip them when the persisted value
    // is explicitly "false" — that keeps fresh installs and missing keys
    // on the documented default.
    getAppSetting("editor_word_wrap")
      .then((val) => { if (val === "false") setEditorWordWrap(false); })
      .catch(() => {});
    getAppSetting("editor_line_numbers")
      .then((val) => { if (val === "false") setEditorLineNumbersEnabled(false); })
      .catch(() => {});
    getAppSetting("editor_font_zoom")
      .then((val) => {
        if (val === null || val === undefined) return;
        const parsed = Number.parseFloat(val);
        if (Number.isFinite(parsed)) setEditorFontZoom(parsed);
      })
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

    // Listen for "Help → Keyboard Shortcuts…" menu clicks. The menu lives
    // in Rust (src-tauri/src/main.rs) but the modal is React, so the menu
    // emits this event and the frontend opens the modal in response.
    const unlistenShortcuts = listen("menu://show-keyboard-shortcuts", () => {
      useAppStore.getState().openModal("keyboard-shortcuts");
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
        ciState: detail.pull_request
          ? deriveScmCiState(detail.pull_request.ci_status, detail.ci_checks)
          : null,
        lastUpdated: Date.now(),
      });
      // Update per-workspace detail for all polled workspaces so switching
      // to any of them shows the PR banner immediately without a new fetch.
      store.setScmDetail(detail);
    });

    // Listen for missing-CLI events (claude/git/gh not on PATH).
    //
    // The store decides whether to auto-open the modal — first occurrence
    // per tool opens it (so non-chat surfaces like auth, repository, SCM,
    // and plugin-settings keep their direct-modal UX), but once the user
    // dismisses the modal for a given tool, subsequent events only refresh
    // the cache. This keeps a high-frequency surface like chat-send from
    // re-popping the modal on every retry while still letting non-chat
    // surfaces show install guidance the first time. The inline "View
    // install options" link in `ChatErrorBanner` calls
    // `openMissingCliModal()`, which clears the dismissal — explicit user
    // action overrides the snooze.
    const unlistenMissingCli = listen<import("./components/modals/MissingCliModal").MissingCliData>(
      "missing-dependency",
      (event) => {
        useAppStore
          .getState()
          .reportMissingCli(event.payload as unknown as Record<string, unknown>);
      },
    );

    // Listen for missing-worktree events. Emitted when a chat / plugin spawn
    // tries to chdir into a worktree directory that has been deleted out
    // from under us. We cache the path so per-workspace UI (chat error
    // banner, sidebar warning) can surface a recovery affordance instead of
    // letting a confusing chained error cascade — historically this case
    // showed up in the UI as "Claude CLI not installed" because chdir(2)
    // and execvp(2) both surface as `ErrorKind::NotFound` from
    // `Command::spawn()`.
    const unlistenMissingWorktree = listen<{ worktree_path: string }>(
      "missing-worktree",
      (event) => {
        useAppStore.getState().setLastMissingWorktree(event.payload.worktree_path);
      },
    );

    // Listen for workspace auto-archived events (e.g. PR merged with archive_on_merge).
    // When `deleted` is true the workspace record was fully removed; otherwise it moved to Archived.
    // CLI- and remote-driven workspace mutations emit this event so the
    // store stays in sync without a manual reload. The full workspace
    // row rides on the payload so we can `addWorkspace` / `updateWorkspace`
    // in one shot — see `src-tauri/src/ops_hooks.rs`.
    const unlistenWorkspacesChanged = listen<{
      kind: "created" | "archived" | "restored" | "deleted" | "renamed";
      workspace_id: string;
      workspace: import("./types/workspace").Workspace | null;
    }>("workspaces-changed", (event) => {
      const { kind, workspace_id, workspace } = event.payload;
      const store = useAppStore.getState();
      if (kind === "deleted") {
        store.removeWorkspace(workspace_id);
        if (store.selectedWorkspaceId === workspace_id) store.selectWorkspace(null);
        return;
      }
      if (workspace === null) {
        // Backend couldn't fetch the fresh row (rare — DB read race or
        // workspace removed between event and read). For "archived" we
        // know enough to apply a partial update and stay live; for
        // every other lifecycle kind a targeted refresh of the workspace
        // list keeps the sidebar consistent without losing per-workspace
        // runtime state (chat sessions, terminals, etc.) the way a full
        // page reload would.
        if (kind === "archived") {
          // Archiving stops the agent process backend-side; mirror that
          // here so a previously-running workspace doesn't keep showing
          // a Running spinner after the row vanishes.
          store.updateWorkspace(workspace_id, {
            status: "Archived",
            agent_status: "Stopped",
          });
        } else {
          loadInitialData()
            .then((data) => {
              // Merge each refreshed row through `addWorkspace` rather
              // than `setWorkspaces` so the slice's status-aware merge
              // preserves live runtime fields (notably `agent_status`,
              // which `db.list_workspaces` synthesizes as Idle on every
              // read). Wholesale-replacing would reintroduce the
              // Running→Idle sidebar regression addWorkspace guards
              // against.
              const s = useAppStore.getState();
              const fresh = s.workspaces;
              const incomingIds = new Set(data.workspaces.map((w) => w.id));
              s.setManualWorkspaceOrderByRepo(
                workspaceOrderModesFromRepoIds(
                  data.manual_workspace_order_repo_ids,
                ),
              );
              for (const ws of data.workspaces) {
                s.addWorkspace({ ...ws, remote_connection_id: null });
              }
              // Drop any local rows the DB no longer knows about (e.g.
              // a hard delete that raced with this refresh). Skip
              // remote workspaces — `loadInitialData` only returns
              // local rows, so a naive removal would evict every
              // remote-connection workspace.
              for (const local of fresh) {
                if (
                  local.remote_connection_id === null &&
                  !incomingIds.has(local.id)
                ) {
                  s.removeWorkspace(local.id);
                }
              }
            })
            .catch((err) =>
              console.warn(
                `workspaces-changed (kind=${kind}) for ${workspace_id} arrived with workspace=null and refresh failed:`,
                err,
              ),
            );
        }
        return;
      }
      // The Rust `claudette::model::Workspace` doesn't include the
      // UI-only `remote_connection_id` field. Stamp it as `null` here so
      // downstream code that strict-checks `=== null` (rather than
      // `!= null` or truthy) doesn't trip on `undefined`. All
      // `workspaces-changed` events come from local ops by definition
      // (the WS server doesn't emit them), so null is correct.
      const stamped = { ...workspace, remote_connection_id: null };

      // Untangle the optimistic-create / optimistic-fork placeholder
      // before adding the real row. Without this swap the user can sit
      // on a `pending-create-*` / `pending-fork-*` id while the backend
      // is already writing to terminal tabs and workspace_terminal_output
      // files under the real id — TerminalPanel queries by selection,
      // finds nothing for the placeholder, and the env-provider output
      // is invisible during the long resolve window the placeholder
      // exists to cover.
      if (kind === "created") {
        const match = findPendingPlaceholderForCreatedWorkspace({
          workspaces: store.workspaces,
          pendingCreates: store.pendingCreates,
          pendingForks: store.pendingForks,
          real: stamped,
        });
        if (match) {
          if (match.from === "create") {
            store.commitPendingCreate(match.placeholderId, stamped);
          } else {
            store.commitPendingFork(match.placeholderId, stamped);
          }
          return;
        }
      }

      // `addWorkspace` is idempotent by id, so this safely handles both
      // new workspaces and re-emitted updates without duplicating.
      // Preparing state is seeded by the backend via a
      // `workspace_env_progress (started)` event emitted at the start
      // of `create_workspace_inner` — handled by the progress listener
      // in `useWorkspaceEnvironmentPreparation` — so the no-placeholder
      // IPC/CLI create path doesn't expose an unprimed worktree, and
      // the fork path (which doesn't run a warmup) doesn't get stranded
      // in a permanent preparing state.
      store.addWorkspace(stamped);
    });

    // Reflect what the agent actually used into the input bar after every
    // turn. Without this, a turn dispatched from the CLI / IPC (or a remote
    // surface that bypasses the toolbar slice) leaves the toolbar showing
    // stale defaults — misleading because the *next* manual send would then
    // diverge from the displayed flags.
    const unlistenChatTurnSettings = listen<{
      workspaceId: string;
      chatSessionId: string;
      model: string | null;
      backendId: string | null;
      fastMode: boolean;
      thinkingEnabled: boolean;
      planMode: boolean;
      effort: string | null;
      chromeEnabled: boolean;
      disable1mContext: boolean;
    }>("chat-turn-settings", (event) => {
      useAppStore.getState().applyChatTurnSettings({
        chatSessionId: event.payload.chatSessionId,
        model: event.payload.model,
        backendId: event.payload.backendId,
        fastMode: event.payload.fastMode,
        thinkingEnabled: event.payload.thinkingEnabled,
        planMode: event.payload.planMode,
        effort: event.payload.effort,
        chromeEnabled: event.payload.chromeEnabled,
      });
    });

    // Flip per-session AND per-workspace `agent_status` to `Running` the
    // moment the backend has actually spawned (or fed) an agent process.
    // For GUI manual sends, ChatPanel sets this optimistically before
    // dispatch — but CLI- and IPC-dispatched turns bypass ChatPanel
    // entirely, leaving the sidebar status icon stuck on Idle until the
    // agent finishes. The matching Idle/Stopped transition is handled by
    // useAgentStream's ProcessExited / result handlers, which already
    // work correctly.
    const unlistenChatTurnStarted = listen<{
      workspaceId: string;
      chatSessionId: string;
    }>("chat-turn-started", (event) => {
      const { workspaceId, chatSessionId } = event.payload;
      const store = useAppStore.getState();
      store.updateChatSession(chatSessionId, { agent_status: "Running" });
      store.updateWorkspace(workspaceId, { agent_status: "Running" });
    });

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
      unlistenShortcuts.then((fn) => fn());
      unlistenZoomIn.then((fn) => fn());
      unlistenZoomOut.then((fn) => fn());
      unlistenResetZoom.then((fn) => fn());
      unlistenScmUpdate.then((fn) => fn());
      unlistenAutoArchived.then((fn) => fn());
      unlistenWorkspacesChanged.then((fn) => fn());
      unlistenChatTurnSettings.then((fn) => fn());
      unlistenChatTurnStarted.then((fn) => fn());
      unlistenMissingCli.then((fn) => fn());
      unlistenMissingWorktree.then((fn) => fn());
    };
  }, [setRepositories, setWorkspaces, setWorktreeBaseDir, setDefaultTerminalAppId, setDefaultBranches, setTerminalFontSize, setLastMessages, setRemoteConnections, setDiscoveredServers, setLocalServerRunning, setLocalServerConnectionString, setCurrentThemeId, setThemeMode, setThemeDark, setThemeLight, setUiFontSize, setFontFamilySans, setFontFamilyMono, setSystemFonts, setDetectedApps, setUsageInsightsEnabled, setClaudetteTerminalEnabled, setShowSidebarRunningCommands, setToolDisplayMode, setExtendedToolCallOutput, setPluginManagementEnabled, setClaudeRemoteControlEnabled, setCommunityRegistryEnabled, setAlternativeBackendsAvailable, setPiSdkAvailable, setAlternativeBackendsEnabled, setCodexEnabled, setAgentBackends, setDefaultAgentBackendId, setClaudeAuthMethod, setEditorGitGutterBase, setEditorMinimapEnabled, setEditorWordWrap, setEditorLineNumbersEnabled, setEditorFontZoom, setDisable1mContext, setAppVersion, setVoiceToggleHotkey, setVoiceHoldHotkey, setKeybindings, setManualWorkspaceOrderByRepo]);

  // Live freshness for LM Studio's `loaded_context_length`.
  //
  // LM Studio is the one backend whose per-model context window can change
  // at any time — the user drags the Context Length slider in LM Studio's
  // UI, hits "Reload model", and the same model id now reports a different
  // loaded context. We need that change reflected in the composer's
  // capacity indicator and in the gateway pre-flight without making the
  // user click Settings → Refresh.
  //
  // Strategy: while at least one LM Studio backend is enabled, poll
  // `refreshAgentBackendModels` for each one every 8 s. That command runs
  // discovery, persists the fresh discovered_models to the DB, and
  // returns the updated config — which we splice into the Zustand store
  // so every consumer (model registry, ContextMeter, SegmentedMeter,
  // ContextPopover, ModelSelector) sees the live value.
  //
  // Cost: one localhost GET per LM Studio backend per 8 s. Discovery
  // round-trip is sub-50 ms in practice. We don't poll OpenAI / Codex —
  // their context windows are immutable so the initial fetch suffices.
  //
  // Important: read the *current* backend list from the Zustand store
  // inside `tick` (via `useAppStore.getState()`), not from the captured
  // `agentBackends` snapshot. Putting `agentBackends` in the dep list
  // would tear the interval down and recreate it on every successful
  // tick (because each tick calls `setAgentBackends`, which produces a
  // new array reference) — leading to canceled in-flight requests and
  // missed refreshes. The effect now only re-runs when the Models-page
  // backend gate flips.
  //
  // Self-scheduling `setTimeout` instead of `setInterval` so the next
  // tick is only queued *after* the current one resolves. With
  // `setInterval`, a slow refresh (overloaded LM Studio, multiple
  // backends, slow disk on the secret-store read) would let multiple
  // ticks run concurrently, race `setAgentBackends`, and hammer the
  // backend's `refresh_agent_backend_models` DB writer. The await-then-
  // schedule pattern makes the period a *floor* (always ≥8 s between
  // tick starts) rather than a ceiling.
  useEffect(() => {
    if (!alternativeBackendsEnabled) return;
    let cancelled = false;
    let timer: number | null = null;
    const tick = async () => {
      const live = useAppStore.getState().agentBackends;
      const ids = live
        .filter((b) => b.kind === "lm_studio" && b.enabled)
        .map((b) => b.id);
      for (const id of ids) {
        if (cancelled) return;
        try {
          const refreshed = await refreshAgentBackendModels(id);
          if (cancelled) return;
          setAgentBackends(refreshed);
        } catch {
          // LM Studio not running, model not loaded, etc. — silent.
          // The ChatPanel surfaces the friendly "backend unreachable"
          // banner separately when the user actually tries to send.
        }
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, 8_000);
      }
    };
    timer = window.setTimeout(tick, 8_000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [alternativeBackendsEnabled, setAgentBackends]);

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

  if (!viewStateHydrated) return null;
  return <AppLayout />;
}

export default App;
