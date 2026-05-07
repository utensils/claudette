import { invoke } from "@tauri-apps/api/core";
import {
  resolveEnabledExtraFlags,
  type ResolvedFlag,
} from "../stores/slices/workspaceClaudeFlagsSlice";

/// One option parsed out of `claude --help`. Mirrors
/// `claudette::claude_help::ClaudeFlagDef` (snake_case via serde default).
export interface ClaudeFlagDef {
  name: string;
  short: string | null;
  takes_value: boolean;
  value_placeholder: string | null;
  enum_choices: string[] | null;
  description: string;
  is_dangerous: boolean;
}

/// Persisted enable/value pair for one flag. Mirrors the `SerializedFlagValue`
/// shape returned by `get_claude_flag_state` (serde default snake_case, but
/// only `enabled` and `value` — both stay the same in camelCase).
export interface FlagValue {
  enabled: boolean;
  value: string | null;
}

/// Discriminated union mirroring `commands::claude_flags::FlagScope`
/// (`#[serde(tag = "kind", rename_all = "camelCase")]`, with `repo_id`
/// renamed to `repoId`).
export type FlagScope =
  | { kind: "global" }
  | { kind: "repo"; repoId: string };

/// Effective state for the requested scope. `global` is always populated;
/// `repo` is populated only when the caller asked for a repo scope and only
/// contains entries that explicitly override global.
export interface FlagStateResponse {
  global: Record<string, FlagValue>;
  repo: Record<string, FlagValue>;
}

export function listClaudeFlags(): Promise<ClaudeFlagDef[]> {
  return invoke("list_claude_flags");
}

export function refreshClaudeFlags(): Promise<ClaudeFlagDef[]> {
  return invoke("refresh_claude_flags");
}

export function getClaudeFlagState(
  scope: FlagScope,
): Promise<FlagStateResponse> {
  return invoke("get_claude_flag_state", { scope });
}

export function setClaudeFlagState(
  scope: FlagScope,
  name: string,
  enabled: boolean,
  value: string | null,
): Promise<void> {
  return invoke("set_claude_flag_state", { scope, name, enabled, value });
}

export function clearClaudeFlagRepoOverride(
  repoId: string,
  name: string,
): Promise<void> {
  return invoke("clear_claude_flag_repo_override", { repoId, name });
}

/// One-shot fetch: pulls the cached flag definitions plus the current global
/// + repo state for the given repo, and runs the resolver to produce the
/// effective enabled-flag list. Used by the workspace flags slice loader.
export async function getResolvedRepoFlags(repoId: string): Promise<{
  defs: ClaudeFlagDef[];
  state: FlagStateResponse;
  resolved: ResolvedFlag[];
}> {
  const [defs, state] = await Promise.all([
    listClaudeFlags(),
    getClaudeFlagState({ kind: "repo", repoId }),
  ]);
  const resolved = resolveEnabledExtraFlags(defs, state.global, state.repo);
  return { defs, state, resolved };
}
