export interface TerminalTab {
  id: number;
  workspace_id: string;
  title: string;
  is_script_output: boolean;
  sort_order: number;
  created_at: string;
  pty_id?: number;
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

export interface SetupResult {
  script_path: string;
  rc_path: string;
  loader_code: string;
  already_integrated: boolean;
}
