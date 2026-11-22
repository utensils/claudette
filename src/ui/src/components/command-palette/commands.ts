import type { LucideIcon } from "lucide-react";
import {
  BadgeDollarSign,
  PanelLeft,
  Terminal,
  GitCompare,
  Brain,
  BookOpen,
  Zap,
  Square,
  RotateCcw,
  Palette,
  Plus,
  Layers,
  Settings,
  Wrench,
  FolderPlus,
  Globe,
  Gauge,
  Sparkles,
  ZoomIn,
  ZoomOut,
  FolderOpen,
  File,
} from "lucide-react";
import i18n from "../../i18n";
import type { ThemeDefinition } from "../../types/theme";
import { getHotkeyLabel } from "../../hotkeys/display";
import type { KeybindingMap } from "../../hotkeys/bindings";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import { MODELS } from "../chat/ModelSelector";
import type { Model } from "../chat/modelRegistry";
import { isFastSupported, isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "../chat/modelCapabilities";
import { CODEX_REASONING_LEVELS } from "../chat/reasoningControls";

export type CommandCategory =
  | "general"
  | "ui"
  | "agent"
  | "theme"
  | "workspace"
  | "navigation"
  | "settings";

export interface Command {
  id: string;
  name: string;
  description?: string;
  category: CommandCategory;
  icon: LucideIcon;
  shortcut?: string;
  keywords?: string[];
  execute: () => void;
}

export interface EffortCommandLabels {
  codexReasoningEffort?: string;
  codexSetReasoningEffort?: string;
}

/** i18n keys of the category headers; resolved at render time. */
export const CATEGORY_LABELS = {
  general: "palette_category_general",
  ui: "palette_category_ui",
  agent: "palette_category_agent",
  theme: "palette_category_theme",
  workspace: "palette_category_workspace",
  navigation: "palette_category_navigation",
  settings: "palette_category_settings",
} as const satisfies Record<CommandCategory, string>;

export const CATEGORY_ORDER: CommandCategory[] = [
  "general",
  "ui",
  "agent",
  "theme",
  "workspace",
  "navigation",
  "settings",
];

export interface GroupedCommands {
  category: CommandCategory;
  label: string;
  commands: Command[];
}

/**
 * Bucket commands by category and order the buckets by CATEGORY_ORDER.
 * The visual rendering order is determined by this function — callers must
 * flatten the result (e.g. `groups.flatMap(g => g.commands)`) and use that
 * flat array for keyboard navigation so the highlighted row and the row
 * Enter executes always agree. Indexing into the input `filteredCommands`
 * order would diverge from the rendering whenever bucket reordering moves
 * a command.
 */
export function groupCommandsByCategory(
  filteredCommands: Command[],
): GroupedCommands[] {
  const map = new Map<CommandCategory, Command[]>();
  for (const cmd of filteredCommands) {
    const arr = map.get(cmd.category) ?? [];
    arr.push(cmd);
    map.set(cmd.category, arr);
  }
  return CATEGORY_ORDER.filter((cat) => map.has(cat)).map((cat) => ({
    category: cat,
    label: i18n.t(CATEGORY_LABELS[cat]),
    commands: map.get(cat)!,
  }));
}

export interface CommandContext {
  // Store actions
  toggleSidebar: () => void;
  toggleTerminalPanel: () => void;
  toggleRightSidebar: () => void;
  toggleFuzzyFinder: () => void;
  openModal: (name: string, data?: Record<string, unknown>) => void;
  openSettings: (section?: string) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  terminalZoomIn: () => void;
  terminalZoomOut: () => void;
  resetTerminalZoom: () => void;
  close: () => void;
  keybindings: KeybindingMap;

  // Theme
  themes: ThemeDefinition[];
  applyThemeById: (id: string) => void;
  enterThemeMode: () => void;
  enterModelMode: () => void;
  enterEffortMode: () => void;
  enterFileMode: () => void;

  // Workspace context
  selectedWorkspaceId: string | null;
  // Active chat session within the selected workspace. Agent commands
  // (stop/reset) run against a session, so this must be resolved before
  // any agent-scoped entry is rendered.
  selectedSessionId: string | null;
  currentRepoId: string | null;
  createWorkspace: (repoId: string) => Promise<void>;

  // Agent (session-scoped toolbar state and lifecycle)
  thinkingEnabled: boolean;
  setThinkingEnabled: (sessionId: string, enabled: boolean) => void;
  planMode: boolean;
  setPlanMode: (sessionId: string, enabled: boolean) => void;
  fastMode: boolean;
  setFastMode: (sessionId: string, enabled: boolean) => void;
  effortLevel: string;
  setEffortLevel: (sessionId: string, level: string) => void;
  selectedModel: string;
  selectedModelProvider: string;
  persistSetting: (key: string, value: string) => void;
  stopAgent: (sessionId: string) => Promise<void>;
  resetAgentSession: (sessionId: string) => Promise<void>;
  clearAgentQuestion: (sessionId: string) => void;
  clearPlanApproval: (sessionId: string) => void;
  clearAgentApproval: (sessionId: string) => void;
  updateWorkspace: (id: string, updates: Record<string, unknown>) => void;
}

/** Build theme sub-menu commands (shown when user selects "Change Theme"). */
export function buildThemeCommands(
  themes: ThemeDefinition[],
  applyThemeById: (id: string) => void,
  close: () => void,
): Command[] {
  return themes.map((theme) => ({
    id: `theme:${theme.id}`,
    name: theme.name,
    description: theme.author ? i18n.t("palette_theme_by_author", { author: theme.author }) : theme.description,
    category: "theme" as const,
    icon: Palette,
    keywords: ["theme", "color", "appearance", ...theme.name.toLowerCase().split(/\s+/)],
    execute: () => { applyThemeById(theme.id); close(); },
  }));
}

/** Build model sub-menu commands. */
export function buildModelCommands(
  selectedModel: string,
  onSelect: (model: string, providerId?: string) => void,
  close: () => void,
  models: readonly Model[] = MODELS,
  selectedProvider = "anthropic",
): Command[] {
  return models.map((m) => ({
    id: `model:${m.providerQualifiedId ?? m.id}`,
    name: `${m.providerLabel ? `${m.providerLabel} / ` : ""}${m.label}${m.id === selectedModel && (m.providerId ?? "anthropic") === selectedProvider ? " ✓" : ""}`,
    description: m.extraUsage ? i18n.t("palette_extra_usage") : undefined,
    category: "agent" as const,
    icon: m.extraUsage ? BadgeDollarSign : Sparkles,
    keywords: ["model", ...m.label.toLowerCase().split(/\s+/)],
    execute: () => { onSelect(m.id, m.providerId ?? "anthropic"); close(); },
  }));
}

/** Build effort sub-menu commands (filtered by model). */
export function buildEffortCommands(
  selectedModel: string,
  currentEffort: string,
  onSelect: (level: string) => void,
  close: () => void,
  selectedProvider = "anthropic",
  labels: EffortCommandLabels = {},
): Command[] {
  if (selectedProvider === "codex" || selectedProvider === "experimental-codex") {
    const effortLabel = labels.codexReasoningEffort ?? "Intelligence";
    const setEffortLabel = labels.codexSetReasoningEffort ?? "Set Codex intelligence";
    const selectedEffort = CODEX_REASONING_LEVELS.some((level) => level.id === currentEffort)
      ? currentEffort
      : "high";
    return CODEX_REASONING_LEVELS.map((level) => ({
      id: `effort:${level.id}`,
      name: `${level.label}${level.id === selectedEffort ? " ✓" : ""}`,
      description: `${effortLabel}: ${level.label}`,
      category: "agent" as const,
      icon: Gauge,
      keywords: [
        effortLabel.toLowerCase(),
        setEffortLabel.toLowerCase(),
        "reasoning",
        level.label.toLowerCase(),
      ],
      execute: () => { onSelect(level.id); close(); },
    }));
  }

  const all = [
    { id: "auto", label: i18n.t("palette_effort_auto"), description: i18n.t("palette_effort_auto_desc") },
    { id: "low", label: i18n.t("palette_effort_low"), description: i18n.t("palette_effort_low_desc") },
    { id: "medium", label: i18n.t("palette_effort_medium"), description: i18n.t("palette_effort_medium_desc") },
    { id: "high", label: i18n.t("palette_effort_high"), description: i18n.t("palette_effort_high_desc") },
    { id: "xhigh", label: i18n.t("palette_effort_xhigh"), description: i18n.t("palette_effort_xhigh_desc") },
    { id: "max", label: i18n.t("palette_effort_max"), description: i18n.t("palette_effort_max_desc") },
  ];
  const levels = !isEffortSupported(selectedModel)
    ? all.filter((l) => l.id === "auto")
    : isXhighEffortAllowed(selectedModel)
      ? all
      : isMaxEffortAllowed(selectedModel)
        ? all.filter((l) => l.id !== "xhigh")
        : all.filter((l) => l.id !== "xhigh" && l.id !== "max");
  return levels.map((l) => ({
    id: `effort:${l.id}`,
    name: `${l.label}${l.id === currentEffort ? " ✓" : ""}`,
    description: l.description,
    category: "agent" as const,
    icon: Gauge,
    keywords: ["effort", "reasoning", l.label.toLowerCase()],
    execute: () => { onSelect(l.id); close(); },
  }));
}

export interface FileEntry {
  path: string;
  is_directory: boolean;
}

/** Build file sub-menu commands from a flat list of workspace file entries. */
export function buildFileCommands(
  files: FileEntry[],
  openFile: (path: string) => void,
  close: () => void,
): Command[] {
  return files
    .filter((f) => !f.is_directory)
    .map((f) => {
      const name = f.path.split("/").pop() ?? f.path;
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      return {
        id: `file:${f.path}`,
        name,
        description: dir || undefined,
        category: "navigation" as const,
        icon: File,
        keywords: f.path.split("/").filter(Boolean),
        execute: () => { openFile(f.path); close(); },
      };
    });
}

export function buildCommands(ctx: CommandContext): Command[] {
  const cmds: Command[] = [];
  const isMac = isMacHotkeyPlatform();
  const shortcut = (actionId: Parameters<typeof getHotkeyLabel>[0]) =>
    getHotkeyLabel(actionId, ctx.keybindings, isMac) ?? undefined;

  // -- UI --
  cmds.push({
    id: "toggle-sidebar",
    name: i18n.t("palette_cmd_toggle_sidebar"),
    category: "ui",
    icon: PanelLeft,
    shortcut: shortcut("global.toggle-sidebar"),
    keywords: ["panel", "left", "hide", "show"],
    execute: () => { ctx.toggleSidebar(); ctx.close(); },
  });
  cmds.push({
    id: "toggle-terminal",
    name: i18n.t("palette_cmd_toggle_terminal"),
    category: "ui",
    icon: Terminal,
    shortcut: shortcut("global.toggle-terminal-panel"),
    keywords: ["shell", "console", "pty"],
    execute: () => { ctx.toggleTerminalPanel(); ctx.close(); },
  });
  cmds.push({
    id: "toggle-changes",
    name: i18n.t("palette_cmd_toggle_changes"),
    category: "ui",
    icon: GitCompare,
    shortcut: shortcut("global.toggle-right-sidebar"),
    keywords: ["diff", "files", "right sidebar"],
    execute: () => { ctx.toggleRightSidebar(); ctx.close(); },
  });
  cmds.push({
    id: "zoom-in",
    name: i18n.t("palette_cmd_zoom_in"),
    description: i18n.t("palette_cmd_zoom_in_desc"),
    category: "ui",
    icon: ZoomIn,
    shortcut: shortcut("global.increase-ui-font"),
    keywords: ["zoom", "larger", "bigger", "font", "size"],
    execute: () => { ctx.zoomIn(); ctx.close(); },
  });
  cmds.push({
    id: "zoom-out",
    name: i18n.t("palette_cmd_zoom_out"),
    description: i18n.t("palette_cmd_zoom_out_desc"),
    category: "ui",
    icon: ZoomOut,
    shortcut: shortcut("global.decrease-ui-font"),
    keywords: ["zoom", "smaller", "font", "size"],
    execute: () => { ctx.zoomOut(); ctx.close(); },
  });
  cmds.push({
    id: "reset-zoom",
    name: i18n.t("palette_cmd_reset_zoom"),
    description: i18n.t("palette_cmd_reset_zoom_desc"),
    category: "ui",
    icon: ZoomIn,
    keywords: ["zoom", "reset", "actual", "default", "font", "size"],
    execute: () => { ctx.resetZoom(); ctx.close(); },
  });
  cmds.push({
    id: "terminal-zoom-in",
    name: i18n.t("palette_cmd_terminal_zoom_in"),
    description: i18n.t("palette_cmd_terminal_zoom_in_desc"),
    category: "ui",
    icon: ZoomIn,
    shortcut: shortcut("global.increase-terminal-font"),
    keywords: ["terminal", "zoom", "larger", "bigger", "font", "size"],
    execute: () => { ctx.terminalZoomIn(); ctx.close(); },
  });
  cmds.push({
    id: "terminal-zoom-out",
    name: i18n.t("palette_cmd_terminal_zoom_out"),
    description: i18n.t("palette_cmd_terminal_zoom_out_desc"),
    category: "ui",
    icon: ZoomOut,
    shortcut: shortcut("global.decrease-terminal-font"),
    keywords: ["terminal", "zoom", "smaller", "font", "size"],
    execute: () => { ctx.terminalZoomOut(); ctx.close(); },
  });
  cmds.push({
    id: "terminal-reset-zoom",
    name: i18n.t("palette_cmd_terminal_reset_zoom"),
    description: i18n.t("palette_cmd_terminal_reset_zoom_desc"),
    category: "ui",
    icon: RotateCcw,
    keywords: ["terminal", "zoom", "reset", "actual", "default", "font", "size"],
    execute: () => { ctx.resetTerminalZoom(); ctx.close(); },
  });

  // -- Agent (only when a session is active) --
  const wsId = ctx.selectedWorkspaceId;
  const sessId = ctx.selectedSessionId;
  if (wsId && sessId) {
    if (
      ctx.selectedModelProvider !== "codex" &&
      ctx.selectedModelProvider !== "experimental-codex"
    ) {
      cmds.push({
        id: "toggle-thinking",
        name: ctx.thinkingEnabled ? i18n.t("palette_cmd_disable_thinking") : i18n.t("palette_cmd_enable_thinking"),
        category: "agent",
        icon: Brain,
        keywords: ["think", "reasoning", "extended"],
        execute: () => {
          const next = !ctx.thinkingEnabled;
          ctx.setThinkingEnabled(sessId, next);
          ctx.persistSetting(`thinking_enabled:${sessId}`, String(next));
          ctx.close();
        },
      });
    }
    cmds.push({
      id: "toggle-plan",
      name: ctx.planMode ? i18n.t("palette_cmd_disable_plan") : i18n.t("palette_cmd_enable_plan"),
      category: "agent",
      icon: BookOpen,
      shortcut: shortcut("global.toggle-plan-mode"),
      keywords: ["planning", "architect"],
      execute: () => {
        const next = !ctx.planMode;
        ctx.setPlanMode(sessId, next);
        ctx.persistSetting(`plan_mode:${sessId}`, String(next));
        ctx.close();
      },
    });
    if (isFastSupported(ctx.selectedModel)) {
      cmds.push({
        id: "toggle-fast",
        name: ctx.fastMode ? i18n.t("palette_cmd_disable_fast") : i18n.t("palette_cmd_enable_fast"),
        category: "agent",
        icon: Zap,
        keywords: ["speed", "quick"],
        execute: () => {
          const next = !ctx.fastMode;
          ctx.setFastMode(sessId, next);
          ctx.persistSetting(`fast_mode:${sessId}`, String(next));
          ctx.close();
        },
      });
    }
    cmds.push({
      id: "change-model",
      name: i18n.t("palette_cmd_change_model"),
      description: i18n.t("palette_cmd_currently", { value: ctx.selectedModel }),
      category: "agent",
      icon: Sparkles,
      keywords: ["model", "opus", "sonnet", "haiku", "switch"],
      execute: () => { ctx.enterModelMode(); },
    });
    if (isEffortSupported(ctx.selectedModel)) {
      cmds.push({
        id: "set-effort",
        name: i18n.t("palette_cmd_set_effort"),
        description: i18n.t("palette_cmd_currently", { value: ctx.effortLevel }),
        category: "agent",
        icon: Gauge,
        keywords: ["effort", "reasoning", "depth", "budget"],
        execute: () => { ctx.enterEffortMode(); },
      });
    }
    cmds.push({
      id: "stop-agent",
      name: i18n.t("palette_cmd_stop_agent"),
      description: i18n.t("palette_cmd_stop_agent_desc"),
      category: "agent",
      icon: Square,
      keywords: ["kill", "cancel", "abort"],
      execute: () => {
        // Stop is per-session — the backend ProcessExited event flips this
        // session's status to Stopped and useAgentStream re-derives the
        // workspace aggregate. Don't force the workspace to Stopped here:
        // other sessions in the workspace may still be running.
        ctx.stopAgent(sessId).catch(console.error);
        ctx.close();
      },
    });
    cmds.push({
      id: "reset-session",
      name: i18n.t("palette_cmd_reset_session"),
      description: i18n.t("palette_cmd_reset_session_desc"),
      category: "agent",
      icon: RotateCcw,
      keywords: ["restart", "new", "clear"],
      execute: () => {
        ctx.resetAgentSession(sessId);
        ctx.clearAgentQuestion(sessId);
        ctx.clearPlanApproval(sessId);
        ctx.clearAgentApproval(sessId);
        ctx.close();
      },
    });
  }

  // -- Theme (single entry → opens sub-menu) --
  cmds.push({
    id: "change-theme",
    name: i18n.t("palette_cmd_change_theme"),
    description: i18n.t("palette_cmd_themes_available", { count: ctx.themes.length }),
    category: "theme",
    icon: Palette,
    keywords: ["theme", "color", "appearance", "dark", "light"],
    execute: () => { ctx.enterThemeMode(); },
  });

  // -- Workspace (only when a repo is available) --
  if (ctx.currentRepoId) {
    const repoId = ctx.currentRepoId;
    cmds.push({
      id: "create-workspace",
      name: i18n.t("palette_cmd_create_workspace"),
      description: i18n.t("palette_cmd_create_workspace_desc"),
      category: "workspace",
      icon: Plus,
      keywords: ["new", "add", "worktree"],
      execute: () => { ctx.createWorkspace(repoId); ctx.close(); },
    });
  }

  // -- Navigation --
  if (ctx.selectedWorkspaceId) {
    cmds.push({
      id: "open-file",
      name: i18n.t("palette_cmd_open_file"),
      description: i18n.t("palette_cmd_open_file_desc"),
      category: "navigation",
      icon: FolderOpen,
      shortcut: shortcut("global.open-command-palette-file-mode"),
      keywords: ["file", "open", "browse", "search", "viewer", "editor"],
      execute: () => { ctx.enterFileMode(); },
    });
  }
  cmds.push({
    id: "switch-workspace",
    name: i18n.t("palette_cmd_switch_workspace"),
    category: "navigation",
    icon: Layers,
    shortcut: shortcut("global.toggle-fuzzy-finder"),
    keywords: ["find", "search", "fuzzy"],
    execute: () => { ctx.close(); ctx.toggleFuzzyFinder(); },
  });

  // -- Settings --
  cmds.push({
    id: "open-settings",
    name: i18n.t("palette_cmd_open_settings"),
    category: "settings",
    icon: Settings,
    shortcut: shortcut("global.open-settings"),
    keywords: ["preferences", "config", "options"],
    execute: () => { ctx.openSettings(); ctx.close(); },
  });
  if (ctx.currentRepoId) {
    cmds.push({
      id: "repo-settings",
      name: i18n.t("palette_cmd_repo_settings"),
      category: "settings",
      icon: Wrench,
      keywords: ["repo", "project", "config"],
      execute: () => { ctx.openSettings(`repo:${ctx.currentRepoId}`); ctx.close(); },
    });
  }
  cmds.push({
    id: "add-repository",
    name: i18n.t("palette_cmd_add_repository"),
    category: "settings",
    icon: FolderPlus,
    keywords: ["repo", "project", "import"],
    execute: () => { ctx.openModal("addRepo"); ctx.close(); },
  });
  cmds.push({
    id: "add-remote",
    name: i18n.t("palette_cmd_add_remote"),
    category: "settings",
    icon: Globe,
    keywords: ["server", "remote", "connect"],
    execute: () => { ctx.openModal("addRemote"); ctx.close(); },
  });

  return cmds;
}
