export interface TerminalTab {
  id: number;
  workspace_id: string;
  title: string;
  kind?: "pty" | "agent_task";
  is_script_output: boolean;
  sort_order: number;
  created_at: string;
  agent_chat_session_id?: string | null;
  agent_tool_use_id?: string | null;
  agent_task_id?: string | null;
  output_path?: string | null;
  task_status?: string | null;
  task_summary?: string | null;
}

export interface WorkspaceCommandState {
  command: string | null;
  isRunning: boolean;
  exitCode: number | null;
}

export interface CommandEvent {
  pty_id: number;
  command: string | null;
  exit_code: number | null;
}

// -- Split-pane layout (view-state persisted, process state excluded) --

export type TerminalPaneNodeId = string;

// "horizontal" = side-by-side columns (divider is vertical)
// "vertical"   = stacked rows (divider is horizontal)
// Matches the terminology the user picks from a "Split horizontally / Split
// vertically" menu: horizontal describes the axis of the resulting panes.
export type TerminalSplitDirection = "horizontal" | "vertical";

export interface TerminalLeafPane {
  kind: "leaf";
  id: TerminalPaneNodeId;
  // Set after spawn_pty resolves; undefined while spawning or after an error.
  ptyId?: number;
  // Non-null when the most recent spawn attempt failed. The UI renders an
  // inline retry banner in place of the xterm canvas until the user retries.
  spawnError?: string | null;
}

export interface TerminalSplitPane {
  kind: "split";
  id: TerminalPaneNodeId;
  direction: TerminalSplitDirection;
  children: [TerminalPaneNode, TerminalPaneNode];
  // Percentages that sum to 100. Drives react-resizable-panels' initial
  // layout and is updated on drag so the split persists across re-renders and
  // app restarts. Persistence stores pane ids, split direction, and sizes only;
  // PTY ids, running commands, and spawn errors are intentionally excluded.
  sizes: [number, number];
}

export type TerminalPaneNode = TerminalLeafPane | TerminalSplitPane;
