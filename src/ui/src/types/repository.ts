export interface Repository {
  id: string;
  path: string;
  name: string;
  path_slug: string;
  icon: string | null;
  created_at: string;
  setup_script: string | null;
  custom_instructions: string | null;
  sort_order: number;
  branch_rename_preferences: string | null;
  setup_script_auto_run: boolean;
  base_branch: string | null;
  default_remote: string | null;
  path_valid: boolean;
  /** Non-null when this repo belongs to a remote connection. */
  remote_connection_id: string | null;
}

export interface SetupResult {
  source: string;
  script: string;
  output: string;
  exit_code: number | null;
  success: boolean;
  timed_out: boolean;
}

export interface CreateWorkspaceResult {
  workspace: import("./workspace").Workspace;
  /**
   * Id of the chat session auto-created alongside the workspace. Use this
   * when posting initial system messages — after the multi-session refactor,
   * chat state is keyed by session id, not workspace id.
   */
  default_session_id: string;
  setup_result: SetupResult | null;
}

export interface RepoConfigInfo {
  has_config_file: boolean;
  setup_script: string | null;
  instructions: string | null;
  parse_error: string | null;
}
