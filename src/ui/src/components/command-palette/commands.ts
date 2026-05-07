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
import type { ThemeDefinition } from "../../types/theme";
import { MODELS } from "../chat/ModelSelector";
import type { Model } from "../chat/modelRegistry";
import { isFastSupported, isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "../chat/modelCapabilities";

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

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  general: "General",
  ui: "Interface",
  agent: "Agent",
  theme: "Theme",
  workspace: "Workspaces",
  navigation: "Navigation",
  settings: "Settings",
};

export const CATEGORY_ORDER: CommandCategory[] = [
  "general",
  "ui",
  "agent",
  "theme",
  "workspace",
  "navigation",
  "settings",
];

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
  close: () => void;

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
  persistSetting: (key: string, value: string) => void;
  stopAgent: (sessionId: string) => Promise<void>;
  resetAgentSession: (sessionId: string) => Promise<void>;
  clearAgentQuestion: (sessionId: string) => void;
  clearPlanApproval: (sessionId: string) => void;
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
    description: theme.author ? `by ${theme.author}` : theme.description,
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
    description: m.extraUsage ? "Extra usage: 1M context billed at API rates" : undefined,
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
): Command[] {
  const all = [
    { id: "auto", label: "Auto", description: "Let CLI decide" },
    { id: "low", label: "Low", description: "Fast, minimal reasoning" },
    { id: "medium", label: "Medium", description: "Balanced" },
    { id: "high", label: "High", description: "Deep reasoning" },
    { id: "xhigh", label: "Extra High", description: "Extended reasoning (Opus 4.7+)" },
    { id: "max", label: "Max", description: "Full budget" },
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
  const isMac = ((navigator as unknown as Record<string, unknown>).userAgentData as { platform?: string } | undefined)
    ?.platform?.toLowerCase().startsWith("mac")
    ?? navigator.platform.startsWith("Mac");
  const mod = isMac ? "Cmd" : "Ctrl";

  // -- UI --
  cmds.push({
    id: "toggle-sidebar",
    name: "Toggle Sidebar",
    category: "ui",
    icon: PanelLeft,
    shortcut: `${mod}+B`,
    keywords: ["panel", "left", "hide", "show"],
    execute: () => { ctx.toggleSidebar(); ctx.close(); },
  });
  cmds.push({
    id: "toggle-terminal",
    name: "Toggle Terminal",
    category: "ui",
    icon: Terminal,
    shortcut: `${mod}+\``,
    keywords: ["shell", "console", "pty"],
    execute: () => { ctx.toggleTerminalPanel(); ctx.close(); },
  });
  cmds.push({
    id: "toggle-changes",
    name: "Toggle Changes Panel",
    category: "ui",
    icon: GitCompare,
    shortcut: `${mod}+D`,
    keywords: ["diff", "files", "right sidebar"],
    execute: () => { ctx.toggleRightSidebar(); ctx.close(); },
  });
  cmds.push({
    id: "zoom-in",
    name: "Zoom In",
    description: "Increase UI font size",
    category: "ui",
    icon: ZoomIn,
    shortcut: `${mod}+=`,
    keywords: ["zoom", "larger", "bigger", "font", "size"],
    execute: () => { ctx.zoomIn(); ctx.close(); },
  });
  cmds.push({
    id: "zoom-out",
    name: "Zoom Out",
    description: "Decrease UI font size",
    category: "ui",
    icon: ZoomOut,
    shortcut: `${mod}+-`,
    keywords: ["zoom", "smaller", "font", "size"],
    execute: () => { ctx.zoomOut(); ctx.close(); },
  });
  cmds.push({
    id: "reset-zoom",
    name: "Reset Zoom",
    description: "Reset UI font size to default (13px)",
    category: "ui",
    icon: ZoomIn,
    keywords: ["zoom", "reset", "actual", "default", "font", "size"],
    execute: () => { ctx.resetZoom(); ctx.close(); },
  });

  // -- Agent (only when a session is active) --
  const wsId = ctx.selectedWorkspaceId;
  const sessId = ctx.selectedSessionId;
  if (wsId && sessId) {
    cmds.push({
      id: "toggle-thinking",
      name: `${ctx.thinkingEnabled ? "Disable" : "Enable"} Thinking Mode`,
      category: "agent",
      icon: Brain,
      shortcut: `${mod}+T`,
      keywords: ["think", "reasoning", "extended"],
      execute: () => {
        const next = !ctx.thinkingEnabled;
        ctx.setThinkingEnabled(sessId, next);
        ctx.persistSetting(`thinking_enabled:${sessId}`, String(next));
        ctx.close();
      },
    });
    cmds.push({
      id: "toggle-plan",
      name: `${ctx.planMode ? "Disable" : "Enable"} Plan Mode`,
      category: "agent",
      icon: BookOpen,
      keywords: ["planning", "architect"],
      execute: () => { ctx.setPlanMode(sessId, !ctx.planMode); ctx.close(); },
    });
    if (isFastSupported(ctx.selectedModel)) {
      cmds.push({
        id: "toggle-fast",
        name: `${ctx.fastMode ? "Disable" : "Enable"} Fast Mode`,
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
      name: "Change Model",
      description: `Currently: ${ctx.selectedModel}`,
      category: "agent",
      icon: Sparkles,
      keywords: ["model", "opus", "sonnet", "haiku", "switch"],
      execute: () => { ctx.enterModelMode(); },
    });
    if (isEffortSupported(ctx.selectedModel)) {
      cmds.push({
        id: "set-effort",
        name: "Set Effort Level",
        description: `Currently: ${ctx.effortLevel}`,
        category: "agent",
        icon: Gauge,
        keywords: ["effort", "reasoning", "depth", "budget"],
        execute: () => { ctx.enterEffortMode(); },
      });
    }
    cmds.push({
      id: "stop-agent",
      name: "Stop Agent",
      description: "Kill the running agent process",
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
      name: "Reset Agent Session",
      description: "Start a fresh session",
      category: "agent",
      icon: RotateCcw,
      keywords: ["restart", "new", "clear"],
      execute: () => { ctx.resetAgentSession(sessId); ctx.clearAgentQuestion(sessId); ctx.clearPlanApproval(sessId); ctx.close(); },
    });
  }

  // -- Theme (single entry → opens sub-menu) --
  cmds.push({
    id: "change-theme",
    name: "Change Theme",
    description: `${ctx.themes.length} themes available`,
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
      name: "Create Workspace",
      description: "New workspace in current repository",
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
      name: "Open File...",
      description: "Browse and open a workspace file",
      category: "navigation",
      icon: FolderOpen,
      shortcut: `${mod}+O`,
      keywords: ["file", "open", "browse", "search", "viewer", "editor"],
      execute: () => { ctx.enterFileMode(); },
    });
  }
  cmds.push({
    id: "switch-workspace",
    name: "Switch Workspace",
    category: "navigation",
    icon: Layers,
    shortcut: `${mod}+K`,
    keywords: ["find", "search", "fuzzy"],
    execute: () => { ctx.close(); ctx.toggleFuzzyFinder(); },
  });

  // -- Settings --
  cmds.push({
    id: "open-settings",
    name: "Open Settings",
    category: "settings",
    icon: Settings,
    keywords: ["preferences", "config", "options"],
    execute: () => { ctx.openSettings(); ctx.close(); },
  });
  if (ctx.currentRepoId) {
    cmds.push({
      id: "repo-settings",
      name: "Repository Settings",
      category: "settings",
      icon: Wrench,
      keywords: ["repo", "project", "config"],
      execute: () => { ctx.openSettings(`repo:${ctx.currentRepoId}`); ctx.close(); },
    });
  }
  cmds.push({
    id: "add-repository",
    name: "Add Repository",
    category: "settings",
    icon: FolderPlus,
    keywords: ["repo", "project", "import"],
    execute: () => { ctx.openModal("addRepo"); ctx.close(); },
  });
  cmds.push({
    id: "add-remote",
    name: "Add Remote Server",
    category: "settings",
    icon: Globe,
    keywords: ["server", "remote", "connect"],
    execute: () => { ctx.openModal("addRemote"); ctx.close(); },
  });

  return cmds;
}
