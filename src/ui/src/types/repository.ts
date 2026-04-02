export interface Repository {
  id: string;
  path: string;
  name: string;
  path_slug: string;
  icon: string | null;
  created_at: string;
  setup_script: string | null;
  custom_instructions: string | null;
  path_valid: boolean;
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
  setup_result: SetupResult | null;
}

export interface RepoConfigInfo {
  has_config_file: boolean;
  setup_script: string | null;
  instructions: string | null;
  parse_error: string | null;
}
