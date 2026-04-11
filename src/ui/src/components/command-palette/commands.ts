import type { LucideIcon } from "lucide-react";
import {
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
} from "lucide-react";
import type { ThemeDefinition } from "../../types/theme";
import { isEffortSupported, isMaxEffortAllowed } from "../chat/EffortSelector";

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
  close: () => void;

  // Theme
  themes: ThemeDefinition[];
  applyThemeById: (id: string) => void;
  enterThemeMode: () => void;

  // Workspace context
  selectedWorkspaceId: string | null;
  currentRepoId: string | null;
  createWorkspace: (repoId: string) => Promise<void>;

  // Agent (workspace-specific)
  thinkingEnabled: boolean;
  setThinkingEnabled: (wsId: string, enabled: boolean) => void;
  planMode: boolean;
  setPlanMode: (wsId: string, enabled: boolean) => void;
  fastMode: boolean;
  setFastMode: (wsId: string, enabled: boolean) => void;
  effortLevel: string;
  setEffortLevel: (wsId: string, level: string) => void;
  selectedModel: string;
  persistSetting: (key: string, value: string) => void;
  stopAgent: (wsId: string) => Promise<void>;
  resetAgentSession: (wsId: string) => Promise<void>;
  clearAgentQuestion: (wsId: string) => void;
  clearPlanApproval: (wsId: string) => void;
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

  // -- Agent (only when workspace selected) --
  const wsId = ctx.selectedWorkspaceId;
  if (wsId) {
    cmds.push({
      id: "toggle-thinking",
      name: `${ctx.thinkingEnabled ? "Disable" : "Enable"} Thinking Mode`,
      category: "agent",
      icon: Brain,
      shortcut: `${mod}+T`,
      keywords: ["think", "reasoning", "extended"],
      execute: () => {
        const next = !ctx.thinkingEnabled;
        ctx.setThinkingEnabled(wsId, next);
        ctx.persistSetting(`thinking_enabled:${wsId}`, String(next));
        ctx.close();
      },
    });
    cmds.push({
      id: "toggle-plan",
      name: `${ctx.planMode ? "Disable" : "Enable"} Plan Mode`,
      category: "agent",
      icon: BookOpen,
      keywords: ["planning", "architect"],
      execute: () => { ctx.setPlanMode(wsId, !ctx.planMode); ctx.close(); },
    });
    cmds.push({
      id: "toggle-fast",
      name: `${ctx.fastMode ? "Disable" : "Enable"} Fast Mode`,
      category: "agent",
      icon: Zap,
      keywords: ["speed", "quick"],
      execute: () => {
        const next = !ctx.fastMode;
        ctx.setFastMode(wsId, next);
        ctx.persistSetting(`fast_mode:${wsId}`, String(next));
        ctx.close();
      },
    });
    cmds.push({
      id: "cycle-effort",
      name: `Effort: ${ctx.effortLevel.charAt(0).toUpperCase() + ctx.effortLevel.slice(1)}`,
      description: "Cycle through effort levels",
      category: "agent",
      icon: Gauge,
      keywords: ["effort", "reasoning", "depth", "budget"],
      execute: () => {
        const levels = !isEffortSupported(ctx.selectedModel)
          ? ["auto"]
          : isMaxEffortAllowed(ctx.selectedModel)
            ? ["auto", "low", "medium", "high", "max"]
            : ["auto", "low", "medium", "high"];
        const idx = levels.indexOf(ctx.effortLevel);
        const next = levels[(idx + 1) % levels.length];
        ctx.setEffortLevel(wsId, next);
        ctx.persistSetting(`effort_level:${wsId}`, next);
        ctx.close();
      },
    });
    cmds.push({
      id: "stop-agent",
      name: "Stop Agent",
      description: "Kill the running agent process",
      category: "agent",
      icon: Square,
      keywords: ["kill", "cancel", "abort"],
      execute: () => {
        ctx.stopAgent(wsId).then(() => ctx.updateWorkspace(wsId, { agent_status: "Stopped" }));
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
      execute: () => { ctx.resetAgentSession(wsId); ctx.clearAgentQuestion(wsId); ctx.clearPlanApproval(wsId); ctx.close(); },
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
    execute: () => { ctx.openModal("appSettings"); ctx.close(); },
  });
  if (ctx.currentRepoId) {
    cmds.push({
      id: "repo-settings",
      name: "Repository Settings",
      category: "settings",
      icon: Wrench,
      keywords: ["repo", "project", "config"],
      execute: () => { ctx.openModal("repoSettings", { repoId: ctx.currentRepoId }); ctx.close(); },
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
