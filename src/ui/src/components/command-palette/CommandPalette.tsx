import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Search, ChevronLeft } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { applyTheme, applyUserFonts, findTheme, loadAllThemes } from "../../utils/theme";
import { adjustUiFontSize, resetUiFontSize } from "../../utils/fontSettings";
import {
  setAppSetting,
  stopAgent,
  resetAgentSession,
  generateWorkspaceName,
  createWorkspace as createWorkspaceService,
  getRepoConfig,
  runWorkspaceSetup,
} from "../../services/tauri";
import { applySelectedModel } from "../chat/applySelectedModel";
import type { ThemeDefinition } from "../../types/theme";
import { scoreCommand } from "./searchScore";
import {
  buildCommands,
  buildThemeCommands,
  buildModelCommands,
  buildEffortCommands,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  type Command,
  type CommandCategory,
} from "./commands";
import styles from "./CommandPalette.module.css";

interface GroupedCommands {
  category: CommandCategory;
  label: string;
  commands: Command[];
}

export function CommandPalette() {
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
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const currentThemeId = useAppStore((s) => s.currentThemeId);
  const setCurrentThemeId = useAppStore((s) => s.setCurrentThemeId);

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
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const setEffortLevel = useAppStore((s) => s.setEffortLevel);
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [themes, setThemes] = useState<ThemeDefinition[]>([]);
  const [mode, setMode] = useState<"main" | "theme" | "model" | "effort">("main");
  const originalThemeIdRef = useRef(currentThemeId);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadAllThemes().then(setThemes).catch(console.error);
  }, []);

  const close = toggleCommandPalette;

  /** Apply a theme and re-apply user font/zoom overrides on top. */
  const applyThemeWithFonts = useCallback((id: string) => {
    applyTheme(findTheme(themes, id));
    const s = useAppStore.getState();
    applyUserFonts(s.fontFamilySans, s.fontFamilyMono, s.uiFontSize);
  }, [themes]);

  const applyThemeById = useCallback((id: string) => {
    applyThemeWithFonts(id);
    setCurrentThemeId(id);
    setAppSetting("theme", id).catch(console.error);
  }, [applyThemeWithFonts, setCurrentThemeId]);

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
            runWorkspaceSetup(wsId).then((sr) => {
              if (sr) {
                const lbl = sr.source === "repo" ? ".claudette.json" : "settings";
                const status = sr.success ? "completed" : sr.timed_out ? "timed out" : "failed";
                addChatMessage(sessionId, {
                  id: crypto.randomUUID(),
                  workspace_id: wsId,
                  chat_session_id: sessionId,
                  role: "System",
                  content: `Setup script (${lbl}) ${status}${sr.output ? `:\n${sr.output}` : ""}`,
                  cost_usd: null, duration_ms: null,
                  created_at: new Date().toISOString(),
                  thinking: null,
                  input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
                });
              }
            }).catch((err) => {
              addChatMessage(sessionId, {
                id: crypto.randomUUID(),
                workspace_id: wsId,
                chat_session_id: sessionId,
                role: "System",
                content: `Setup script failed: ${err}`,
                cost_usd: null, duration_ms: null,
                created_at: new Date().toISOString(),
                thinking: null,
                input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null,
              });
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
  }, [addWorkspace, selectWorkspace, addChatMessage, openModal]);

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
        close,
        themes,
        applyThemeById,
        enterThemeMode,
        enterModelMode,
        enterEffortMode,
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
        persistSetting: (key: string, value: string) => setAppSetting(key, value).catch(console.error),
        stopAgent: (sessionId: string) => stopAgent(sessionId),
        resetAgentSession: (sessionId: string) => resetAgentSession(sessionId),
        clearAgentQuestion: (sessionId: string) => clearAgentQuestion(sessionId),
        clearPlanApproval: (sessionId: string) => clearPlanApproval(sessionId),
        updateWorkspace: (id: string, updates: Record<string, unknown>) => updateWorkspace(id, updates),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, selectedWorkspaceId, selectedSessionId, currentRepoId, thinkingEnabled, planMode, fastMode, effortLevel, selectedModel, enterThemeMode, applyThemeById, handleCreateWorkspace],
  );

  // Build sub-menu command lists
  const themeCommands = useMemo(
    () => buildThemeCommands(themes, applyThemeById, close),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, applyThemeById],
  );

  const modelCommands = useMemo(
    () => buildModelCommands(
      selectedModel,
      async (model: string) => {
        if (!selectedSessionId || model === selectedModel) return;
        await applySelectedModel(selectedSessionId, model);
      },
      close,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedModel, selectedSessionId],
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
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedModel, effortLevel, selectedSessionId],
  );

  // Active command list based on mode
  const activeCommands =
    mode === "theme" ? themeCommands
    : mode === "model" ? modelCommands
    : mode === "effort" ? effortCommands
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
    // When searching, show a flat ranked list (no category grouping)
    // so the relevance sort isn't overridden by category order.
    if (query.trim()) {
      return filteredCommands.length > 0
        ? [{ category: "general", label: "Results", commands: filteredCommands }]
        : [];
    }
    const map = new Map<CommandCategory, Command[]>();
    for (const cmd of filteredCommands) {
      const arr = map.get(cmd.category) ?? [];
      arr.push(cmd);
      map.set(cmd.category, arr);
    }
    return CATEGORY_ORDER.filter((cat) => map.has(cat)).map((cat) => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      commands: map.get(cat)!,
    }));
  }, [filteredCommands, mode]);

  // Theme live preview on arrow navigation (only in theme mode)
  useEffect(() => {
    if (mode !== "theme" || themes.length === 0) return;
    const cmd = filteredCommands[selectedIndex];
    if (cmd?.id.startsWith("theme:")) {
      const themeId = cmd.id.slice("theme:".length);
      applyThemeWithFonts(themeId);
    }
  }, [selectedIndex, filteredCommands, themes, mode]);

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
      setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filteredCommands[selectedIndex]) {
      e.preventDefault();
      filteredCommands[selectedIndex].execute();
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

  let flatIndex = 0;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
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
              : "Type a command..."
            }
            autoFocus
          />
          {mode !== "main" && (
            <span className={styles.modeBadge}>
              {mode === "theme" ? "Theme" : mode === "model" ? "Model" : "Effort"}
            </span>
          )}
        </div>

        <div className={styles.results} ref={resultsRef}>
          {filteredCommands.length === 0 ? (
            <div className={styles.empty}>
              {mode === "theme" ? "No matching themes"
                : mode === "model" ? "No matching models"
                : mode === "effort" ? "No matching levels"
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
