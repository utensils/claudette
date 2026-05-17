import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, ChevronLeft } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { applyTheme, applyUserFonts, findTheme, loadAllThemes, cacheThemePreference, getThemeDataAttr } from "../../utils/theme";
import {
  adjustTerminalFontSize,
  adjustUiFontSize,
  resetTerminalFontSize,
  resetUiFontSize,
} from "../../utils/fontSettings";
import {
  setAppSetting,
  stopAgent,
  resetAgentSession,
  generateWorkspaceName,
  createWorkspace as createWorkspaceService,
  getRepoConfig,
  runWorkspaceSetup,
  listWorkspaceFiles,
} from "../../services/tauri";
import { applySelectedModel } from "../chat/applySelectedModel";
import { useModelRegistry } from "../chat/useModelRegistry";
import { runAndRecordSetupScript } from "../../utils/setupScriptMessage";
import type { ThemeDefinition } from "../../types/theme";
import { scoreCommand } from "./searchScore";
import {
  buildCommands,
  buildThemeCommands,
  buildModelCommands,
  buildEffortCommands,
  buildFileCommands,
  groupCommandsByCategory,
  type FileEntry,
  type GroupedCommands,
} from "./commands";
import styles from "./CommandPalette.module.css";

export function CommandPalette() {
  const { t } = useTranslation("chat");
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleTerminalPanel = useAppStore((s) => s.toggleTerminalPanel);
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar);
  const toggleFuzzyFinder = useAppStore((s) => s.toggleFuzzyFinder);
  const openModal = useAppStore((s) => s.openModal);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  // Active chat session within the selected workspace. Agent-scoped
  // commands (stop, reset, model-change teardown) run against a session
  // id, not the workspace id.
  const selectedSessionId = useAppStore((s) =>
    s.selectedWorkspaceId
      ? s.selectedSessionIdByWorkspaceId[s.selectedWorkspaceId] ?? null
      : null,
  );
  const workspaces = useAppStore((s) => s.workspaces);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const addToast = useAppStore((s) => s.addToast);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const currentThemeId = useAppStore((s) => s.currentThemeId);
  const setCurrentThemeId = useAppStore((s) => s.setCurrentThemeId);
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeDark = useAppStore((s) => s.setThemeDark);
  const setThemeLight = useAppStore((s) => s.setThemeLight);

  // Resolve current repo from selected workspace
  const currentRepoId = useMemo(() => {
    if (!selectedWorkspaceId) return null;
    const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
    return ws?.repository_id ?? null;
  }, [selectedWorkspaceId, workspaces]);

  const thinkingEnabled = useAppStore(
    (s) => (selectedSessionId ? s.thinkingEnabled[selectedSessionId] ?? false : false),
  );
  const planMode = useAppStore(
    (s) => (selectedSessionId ? s.planMode[selectedSessionId] ?? false : false),
  );
  const fastMode = useAppStore(
    (s) => (selectedSessionId ? s.fastMode[selectedSessionId] ?? false : false),
  );
  const effortLevel = useAppStore(
    (s) => (selectedSessionId ? s.effortLevel[selectedSessionId] ?? "auto" : "auto"),
  );
  const selectedModel = useAppStore(
    (s) => (selectedSessionId ? s.selectedModel[selectedSessionId] ?? "opus" : "opus"),
  );
  const selectedModelProvider = useAppStore(
    (s) => (selectedSessionId ? s.selectedModelProvider[selectedSessionId] ?? "anthropic" : "anthropic"),
  );
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const setEffortLevel = useAppStore((s) => s.setEffortLevel);
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const clearAgentApproval = useAppStore((s) => s.clearAgentApproval);
  const openFileTab = useAppStore((s) => s.openFileTab);
  const keybindings = useAppStore((s) => s.keybindings);
  const commandPaletteInitialMode = useAppStore((s) => s.commandPaletteInitialMode);
  const clearCommandPaletteInitialMode = useAppStore((s) => s.clearCommandPaletteInitialMode);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [themes, setThemes] = useState<ThemeDefinition[]>([]);
  const [mode, setMode] = useState<"main" | "theme" | "model" | "effort" | "file">("main");
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesLoadError, setFilesLoadError] = useState<string | null>(null);
  // Monotonic token bumped on each `enterFileMode` invocation so a late
  // `listWorkspaceFiles` response from a previous workspace can detect it's
  // stale and skip overwriting `fileEntries` with the wrong list.
  const filesLoadVersionRef = useRef(0);
  const originalThemeIdRef = useRef(currentThemeId);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadAllThemes().then(setThemes).catch(console.error);
  }, []);

  // `autoFocus` is best-effort: in the Tauri webview the palette can mount
  // while the OS still has focus elsewhere, so the search input never picks
  // it up and Arrow keys fall through to the document. Schedule an explicit
  // focus on mount and after each sub-mode transition so the keyboard
  // handler on the input is the one that fires.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [mode]);

  const close = toggleCommandPalette;

  /** Apply a theme and re-apply user font/zoom overrides on top. */
  const applyThemeWithFonts = useCallback((id: string) => {
    applyTheme(findTheme(themes, id));
    const s = useAppStore.getState();
    applyUserFonts(s.fontFamilySans, s.fontFamilyMono, s.uiFontSize);
  }, [themes]);

  const applyThemeById = useCallback((id: string) => {
    const theme = findTheme(themes, id);
    applyThemeWithFonts(theme.id);
    setCurrentThemeId(theme.id);
    // Write to the mode-appropriate key so the Settings UI stays consistent.
    // In system mode, apply to the key for the currently active OS preference.
    const isSystemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const effectiveMode = themeMode === "system" ? (isSystemDark ? "dark" : "light") : themeMode;
    if (effectiveMode === "light") {
      setThemeLight(theme.id);
      const state = useAppStore.getState();
      const darkTheme = findTheme(themes, state.themeDark);
      cacheThemePreference(themeMode, getThemeDataAttr(darkTheme), getThemeDataAttr(theme));
      setAppSetting("theme_light", theme.id).catch(console.error);
    } else {
      setThemeDark(theme.id);
      const state = useAppStore.getState();
      const lightTheme = findTheme(themes, state.themeLight);
      cacheThemePreference(themeMode, getThemeDataAttr(theme), getThemeDataAttr(lightTheme));
      setAppSetting("theme_dark", theme.id).catch(console.error);
    }
  }, [applyThemeWithFonts, setCurrentThemeId, themeMode, themes, setThemeDark, setThemeLight]);

  const handleCreateWorkspace = useCallback(async (repoId: string) => {
    try {
      const generated = await generateWorkspaceName();
      const result = await createWorkspaceService(repoId, generated.slug, true);
      addWorkspace(result.workspace);
      selectWorkspace(result.workspace.id);
      const sessionId = result.default_session_id;
      if (generated.message) {
        addChatMessage(sessionId, {
          id: crypto.randomUUID(),
          workspace_id: result.workspace.id,
          chat_session_id: sessionId,
          role: "System",
          content: generated.message,
          cost_usd: null,
          duration_ms: null,
          created_at: new Date().toISOString(),
          thinking: null,
          input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
        });
      }
      // Check for setup script and prompt for confirmation.
      try {
        const config = await getRepoConfig(repoId);
        const repo = useAppStore.getState().repositories.find((r) => r.id === repoId);
        const script = config.setup_script ?? repo?.setup_script;
        const source = config.setup_script ? "repo" : "settings";
        if (script) {
          if (repo?.setup_script_auto_run) {
            const wsId = result.workspace.id;
            runAndRecordSetupScript({
              sessionId,
              workspaceId: wsId,
              source,
              run: () => runWorkspaceSetup(wsId),
              deps: {
                addChatMessage,
                setRunningSetupScript: useAppStore.getState().setRunningSetupScript,
                addToast,
                workspaceName: result.workspace.name,
              },
            });
          } else {
            openModal("confirmSetupScript", {
              workspaceId: result.workspace.id,
              sessionId,
              repoId,
              script,
              source,
            });
          }
        }
      } catch {
        // No config — no setup script to run.
      }
    } catch (e) {
      console.error("Failed to create workspace:", e);
    }
  }, [addWorkspace, selectWorkspace, addChatMessage, addToast, openModal]);

  const enterThemeMode = useCallback(() => {
    setMode("theme");
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const enterModelMode = useCallback(() => {
    setMode("model");
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const enterEffortMode = useCallback(() => {
    setMode("effort");
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const enterFileMode = useCallback(() => {
    if (!selectedWorkspaceId) return;
    setMode("file");
    setQuery("");
    setSelectedIndex(0);
    setFilesLoading(true);
    setFilesLoadError(null);
    const version = ++filesLoadVersionRef.current;
    listWorkspaceFiles(selectedWorkspaceId)
      .then((entries) => {
        if (version !== filesLoadVersionRef.current) return;
        setFileEntries(entries);
        setFilesLoading(false);
      })
      .catch((err) => {
        if (version !== filesLoadVersionRef.current) return;
        console.error("[CommandPalette] Failed to load workspace files:", err);
        setFileEntries([]);
        setFilesLoadError(String(err));
        setFilesLoading(false);
      });
  }, [selectedWorkspaceId]);

  // If the palette was opened with an initial file mode (e.g. via Cmd+O), enter it.
  useEffect(() => {
    if (commandPaletteInitialMode === "file") {
      clearCommandPaletteInitialMode();
      enterFileMode();
    }
  }, [commandPaletteInitialMode, clearCommandPaletteInitialMode, enterFileMode]);

  const exitSubMenu = useCallback(() => {
    setMode("main");
    setQuery("");
    setSelectedIndex(0);
    // Revert any theme preview
    if (themes.length > 0) {
      applyThemeWithFonts(originalThemeIdRef.current);
    }
  }, [themes]);

  // Build main commands
  const mainCommands = useMemo(
    () =>
      buildCommands({
        toggleSidebar,
        toggleTerminalPanel,
        toggleRightSidebar,
        toggleFuzzyFinder,
        openModal,
        openSettings: useAppStore.getState().openSettings,
        zoomIn: () => adjustUiFontSize(+1),
        zoomOut: () => adjustUiFontSize(-1),
        resetZoom: () => resetUiFontSize(),
        terminalZoomIn: () => adjustTerminalFontSize(+1),
        terminalZoomOut: () => adjustTerminalFontSize(-1),
        resetTerminalZoom: () => resetTerminalFontSize(),
        close,
        keybindings,
        themes,
        applyThemeById,
        enterThemeMode,
        enterModelMode,
        enterEffortMode,
        enterFileMode,
        selectedWorkspaceId,
        selectedSessionId,
        currentRepoId,
        createWorkspace: handleCreateWorkspace,
        thinkingEnabled,
        setThinkingEnabled,
        planMode,
        setPlanMode,
        fastMode,
        setFastMode,
        effortLevel,
        setEffortLevel,
        selectedModel,
        selectedModelProvider,
        persistSetting: (key: string, value: string) => setAppSetting(key, value).catch(console.error),
        stopAgent: (sessionId: string) => {
          const state = useAppStore.getState();
          const queue = state.queuedMessages[sessionId];
          if (queue && queue.length > 0) {
            state.setQueuedMessageAutoDispatchPaused(sessionId, true);
          }
          return stopAgent(sessionId);
        },
        resetAgentSession: (sessionId: string) => resetAgentSession(sessionId),
        clearAgentQuestion: (sessionId: string) => clearAgentQuestion(sessionId),
        clearPlanApproval: (sessionId: string) => clearPlanApproval(sessionId),
        clearAgentApproval: (sessionId: string) => clearAgentApproval(sessionId),
        updateWorkspace: (id: string, updates: Record<string, unknown>) => updateWorkspace(id, updates),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, selectedWorkspaceId, selectedSessionId, currentRepoId, thinkingEnabled, planMode, fastMode, effortLevel, selectedModel, selectedModelProvider, keybindings, enterThemeMode, enterFileMode, applyThemeById, handleCreateWorkspace, clearAgentApproval],
  );

  // Build sub-menu command lists
  const themeCommands = useMemo(
    () => buildThemeCommands(themes, applyThemeById, close),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, applyThemeById],
  );

  // Single source for visibility — `useModelRegistry` applies the
  // Claude-OAuth Pi-anthropic gate so the palette can't surface a
  // model the Rust resolver would refuse.
  const modelRegistry = useModelRegistry();

  const modelCommands = useMemo(
    () => buildModelCommands(
      selectedModel,
      async (model: string, providerId = "anthropic") => {
        if (!selectedSessionId || (model === selectedModel && providerId === selectedModelProvider)) return;
        await applySelectedModel(selectedSessionId, model, providerId);
      },
      close,
      modelRegistry,
      selectedModelProvider,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedModel, selectedModelProvider, selectedSessionId, modelRegistry],
  );

  const effortCommands = useMemo(
    () => buildEffortCommands(
      selectedModel,
      effortLevel,
      async (level: string) => {
        if (!selectedSessionId) return;
        useAppStore.getState().setEffortLevel(selectedSessionId, level);
        await setAppSetting(`effort_level:${selectedSessionId}`, level);
      },
      close,
      selectedModelProvider,
      {
        codexReasoningEffort: t("codex_reasoning_effort"),
        codexSetReasoningEffort: t("codex_set_reasoning_effort"),
      },
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedModel, selectedModelProvider, effortLevel, selectedSessionId, t],
  );

  const fileCommands = useMemo(
    () =>
      buildFileCommands(
        fileEntries,
        (path) => {
          if (selectedWorkspaceId) openFileTab(selectedWorkspaceId, path);
        },
        close,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileEntries, selectedWorkspaceId],
  );

  // Active command list based on mode
  const activeCommands =
    mode === "theme" ? themeCommands
    : mode === "model" ? modelCommands
    : mode === "effort" ? effortCommands
    : mode === "file" ? fileCommands
    : mainCommands;

  const filteredCommands = useMemo(() => {
    if (!query.trim()) return activeCommands;

    const scored = activeCommands
      .map((cmd) => ({
        cmd,
        score: scoreCommand(cmd.name, cmd.description, cmd.keywords, query),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.map(({ cmd }) => cmd);
  }, [activeCommands, query]);

  const grouped = useMemo<GroupedCommands[]>(() => {
    if (mode === "theme") {
      return filteredCommands.length > 0
        ? [{ category: "theme", label: "Select a Theme", commands: filteredCommands }]
        : [];
    }
    if (mode === "file") {
      return filteredCommands.length > 0
        ? [{ category: "navigation", label: "Files", commands: filteredCommands }]
        : [];
    }
    // When searching, show a flat ranked list (no category grouping)
    // so the relevance sort isn't overridden by category order.
    if (query.trim()) {
      return filteredCommands.length > 0
        ? [{ category: "general", label: "Results", commands: filteredCommands }]
        : [];
    }
    return groupCommandsByCategory(filteredCommands);
  }, [filteredCommands, mode]);

  // Rendered (visual) order — what arrow keys must index into so the
  // highlighted row and the command executed on Enter always agree.
  // Without this, browsing the main mode (no query) would highlight the
  // category-sorted row N but Enter would fire activeCommands[N].
  const flatCommands = useMemo(
    () => grouped.flatMap((g) => g.commands),
    [grouped],
  );

  // Keep the highlight within bounds when filtering shrinks the list
  // (e.g. typing extra characters that remove matches under the cursor).
  useEffect(() => {
    if (flatCommands.length === 0) {
      if (selectedIndex !== 0) setSelectedIndex(0);
      return;
    }
    if (selectedIndex > flatCommands.length - 1) {
      setSelectedIndex(flatCommands.length - 1);
    }
  }, [flatCommands.length, selectedIndex]);

  // Theme live preview on arrow navigation (only in theme mode)
  useEffect(() => {
    if (mode !== "theme" || themes.length === 0) return;
    const cmd = flatCommands[selectedIndex];
    if (cmd?.id.startsWith("theme:")) {
      const themeId = cmd.id.slice("theme:".length);
      applyThemeWithFonts(themeId);
    }
  }, [selectedIndex, flatCommands, themes, mode]);

  // Revert theme on unmount (safety net)
  useEffect(() => {
    return () => {
      const storeThemeId = useAppStore.getState().currentThemeId;
      loadAllThemes()
        .then((all) => {
          applyTheme(findTheme(all, storeThemeId));
          const s = useAppStore.getState();
          applyUserFonts(s.fontFamilySans, s.fontFamilyMono, s.uiFontSize);
        })
        .catch(() => {});
    };
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    const el = resultsRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) =>
        flatCommands.length === 0 ? 0 : Math.min(i + 1, flatCommands.length - 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && flatCommands[selectedIndex]) {
      e.preventDefault();
      flatCommands[selectedIndex].execute();
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Stop propagation so the global keyboard shortcut handler doesn't
      // also close the palette when we just want to exit theme mode.
      e.nativeEvent.stopImmediatePropagation();
      if (mode !== "main") {
        exitSubMenu();
      } else {
        if (themes.length > 0) {
          applyThemeWithFonts(originalThemeIdRef.current);
        }
        close();
      }
    } else if (e.key === "Backspace" && query === "" && mode !== "main") {
      // Backspace on empty input in sub-menu → go back
      exitSubMenu();
    }
  };

  const handleBackdropClick = () => {
    if (themes.length > 0) {
      applyThemeWithFonts(originalThemeIdRef.current);
    }
    close();
  };

  // Fallback keydown for the whole card: result rows preventDefault on
  // mousedown so the input keeps focus, but any other focus drift (browser
  // weirdness, an injected button taking focus) would leave arrow keys
  // dead. Re-dispatch them through the same handler, and for any printable
  // key bounce focus back to the input AND apply the character so the
  // triggering keystroke isn't dropped.
  const handleCardKeyDown = (e: React.KeyboardEvent) => {
    if (e.target === inputRef.current) return;
    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "Enter" ||
      e.key === "Escape" ||
      e.key === "Backspace"
    ) {
      handleKeyDown(e);
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      inputRef.current?.focus();
      setQuery((q) => q + e.key);
      setSelectedIndex(0);
    }
  };

  let flatIndex = 0;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        className={styles.card}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleCardKeyDown}
      >
        <div className={styles.inputRow}>
          {mode !== "main" ? (
            <button
              className={styles.backBtn}
              onClick={exitSubMenu}
              title="Back to commands"
              type="button"
            >
              <ChevronLeft size={16} />
            </button>
          ) : (
            <Search size={16} className={styles.inputIcon} />
          )}
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === "theme" ? "Search themes..."
              : mode === "model" ? "Select model..."
              : mode === "effort" ? "Select effort level..."
              : mode === "file" ? "Search files..."
              : "Type a command..."
            }
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {mode !== "main" && (
            <span className={styles.modeBadge}>
              {mode === "theme" ? "Theme"
                : mode === "model" ? "Model"
                : mode === "effort" ? "Effort"
                : "Files"}
            </span>
          )}
        </div>

        <div className={styles.results} ref={resultsRef}>
          {filteredCommands.length === 0 ? (
            <div className={styles.empty}>
              {mode === "theme" ? "No matching themes"
                : mode === "model" ? "No matching models"
                : mode === "effort" ? "No matching levels"
                : mode === "file" ? (filesLoading ? "Loading files..." : filesLoadError ? `Failed to load files: ${filesLoadError}` : "No matching files")
                : "No matching commands"}
            </div>
          ) : (
            grouped.map((group) => {
              const items = group.commands.map((cmd) => {
                const idx = flatIndex++;
                const Icon = cmd.icon;
                const isTheme = cmd.id.startsWith("theme:");
                const themeColor = isTheme
                  ? themes.find((t) => t.id === cmd.id.slice("theme:".length))
                      ?.colors["accent-primary"]
                  : undefined;
                const isActive = isTheme &&
                  cmd.id.slice("theme:".length) === currentThemeId;

                return (
                  <div
                    key={cmd.id}
                    data-index={idx}
                    className={`${styles.result} ${idx === selectedIndex ? styles.resultSelected : ""}`}
                    onClick={() => cmd.execute()}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    {themeColor ? (
                      <span
                        className={styles.themeSwatch}
                        style={{ background: themeColor }}
                      />
                    ) : (
                      <Icon size={18} className={styles.resultIcon} />
                    )}
                    <div className={styles.resultBody}>
                      <div className={styles.resultName}>
                        {cmd.name}
                        {isActive && (
                          <span className={styles.activeBadge}>current</span>
                        )}
                      </div>
                      {cmd.description && (
                        <div className={styles.resultDescription}>
                          {cmd.description}
                        </div>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <div className={styles.shortcut}>
                        {cmd.shortcut.split("+").map((key) => (
                          <span key={key} className={styles.kbd}>
                            {key}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              });

              return (
                <div key={group.category}>
                  {mode === "main" && (
                    <div className={styles.categoryHeader}>{group.label}</div>
                  )}
                  {items}
                </div>
              );
            })
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerHint}>
            <span className={styles.kbd}>↑↓</span> navigate
          </span>
          <span className={styles.footerHint}>
            <span className={styles.kbd}>↵</span> select
          </span>
          <span className={styles.footerHint}>
            <span className={styles.kbd}>esc</span>
            {mode !== "main" ? " back" : " close"}
          </span>
        </div>
      </div>
    </div>
  );
}
