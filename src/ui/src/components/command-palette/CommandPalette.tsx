import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Search, ChevronLeft } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { applyTheme, findTheme, loadAllThemes } from "../../utils/theme";
import {
  setAppSetting,
  stopAgent,
  resetAgentSession,
  generateWorkspaceName,
  createWorkspace as createWorkspaceService,
} from "../../services/tauri";
import type { ThemeDefinition } from "../../types/theme";
import {
  buildCommands,
  buildThemeCommands,
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
    (s) => (selectedWorkspaceId ? s.thinkingEnabled[selectedWorkspaceId] ?? false : false),
  );
  const planMode = useAppStore(
    (s) => (selectedWorkspaceId ? s.planMode[selectedWorkspaceId] ?? false : false),
  );
  const fastMode = useAppStore(
    (s) => (selectedWorkspaceId ? s.fastMode[selectedWorkspaceId] ?? false : false),
  );
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [themes, setThemes] = useState<ThemeDefinition[]>([]);
  const [mode, setMode] = useState<"main" | "theme">("main");
  const originalThemeIdRef = useRef(currentThemeId);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadAllThemes().then(setThemes).catch(console.error);
  }, []);

  const close = toggleCommandPalette;

  const applyThemeById = useCallback((id: string) => {
    const theme = findTheme(themes, id);
    applyTheme(theme);
    setCurrentThemeId(id);
    setAppSetting("theme", id).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themes, setCurrentThemeId]);

  const handleCreateWorkspace = useCallback(async (repoId: string) => {
    try {
      const generated = await generateWorkspaceName();
      const result = await createWorkspaceService(repoId, generated.slug);
      addWorkspace(result.workspace);
      selectWorkspace(result.workspace.id);
      if (generated.message) {
        addChatMessage(result.workspace.id, {
          id: crypto.randomUUID(),
          workspace_id: result.workspace.id,
          role: "System",
          content: generated.message,
          cost_usd: null,
          duration_ms: null,
          created_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error("Failed to create workspace:", e);
    }
  }, [addWorkspace, selectWorkspace, addChatMessage]);

  const enterThemeMode = useCallback(() => {
    setMode("theme");
    setQuery("");
    setSelectedIndex(0);
  }, []);

  const exitThemeMode = useCallback(() => {
    setMode("main");
    setQuery("");
    setSelectedIndex(0);
    // Revert any theme preview
    if (themes.length > 0) {
      applyTheme(findTheme(themes, originalThemeIdRef.current));
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
        close,
        themes,
        applyThemeById,
        enterThemeMode,
        selectedWorkspaceId,
        currentRepoId,
        createWorkspace: handleCreateWorkspace,
        thinkingEnabled,
        setThinkingEnabled,
        planMode,
        setPlanMode,
        fastMode,
        setFastMode,
        persistSetting: (key: string, value: string) => setAppSetting(key, value).catch(console.error),
        stopAgent: (wsId: string) => stopAgent(wsId),
        resetAgentSession: (wsId: string) => resetAgentSession(wsId),
        clearAgentQuestion: (wsId: string) => clearAgentQuestion(wsId),
        updateWorkspace: (id: string, updates: Record<string, unknown>) => updateWorkspace(id, updates),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, selectedWorkspaceId, currentRepoId, thinkingEnabled, planMode, fastMode, enterThemeMode, applyThemeById, handleCreateWorkspace],
  );

  // Build theme sub-menu commands
  const themeCommands = useMemo(
    () => buildThemeCommands(themes, applyThemeById, close),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themes, applyThemeById],
  );

  // Active command list based on mode
  const activeCommands = mode === "theme" ? themeCommands : mainCommands;

  const filteredCommands = useMemo(() => {
    if (!query.trim()) return activeCommands;
    const q = query.toLowerCase();
    return activeCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) ||
        cmd.description?.toLowerCase().includes(q) ||
        cmd.keywords?.some((k) => k.includes(q)),
    );
  }, [activeCommands, query]);

  const grouped = useMemo<GroupedCommands[]>(() => {
    if (mode === "theme") {
      // Theme mode: flat list, no category grouping
      return filteredCommands.length > 0
        ? [{ category: "theme", label: "Select a Theme", commands: filteredCommands }]
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
      applyTheme(findTheme(themes, themeId));
    }
  }, [selectedIndex, filteredCommands, themes, mode]);

  // Revert theme on unmount (safety net)
  useEffect(() => {
    return () => {
      const storeThemeId = useAppStore.getState().currentThemeId;
      loadAllThemes()
        .then((all) => applyTheme(findTheme(all, storeThemeId)))
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
      if (mode === "theme") {
        exitThemeMode();
      } else {
        if (themes.length > 0) {
          applyTheme(findTheme(themes, originalThemeIdRef.current));
        }
        close();
      }
    } else if (e.key === "Backspace" && query === "" && mode === "theme") {
      // Backspace on empty input in theme mode → go back
      exitThemeMode();
    }
  };

  const handleBackdropClick = () => {
    if (themes.length > 0) {
      applyTheme(findTheme(themes, originalThemeIdRef.current));
    }
    close();
  };

  let flatIndex = 0;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.inputRow}>
          {mode === "theme" ? (
            <button
              className={styles.backBtn}
              onClick={exitThemeMode}
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
            placeholder={mode === "theme" ? "Search themes..." : "Type a command..."}
            autoFocus
          />
          {mode === "theme" && (
            <span className={styles.modeBadge}>Theme</span>
          )}
        </div>

        <div className={styles.results} ref={resultsRef}>
          {filteredCommands.length === 0 ? (
            <div className={styles.empty}>
              {mode === "theme" ? "No matching themes" : "No matching commands"}
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
            {mode === "theme" ? " back" : " close"}
          </span>
        </div>
      </div>
    </div>
  );
}
