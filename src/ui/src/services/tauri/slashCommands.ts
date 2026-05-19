import { invoke } from "@tauri-apps/api/core";

export type NativeSlashKind =
  | "local_action"
  | "settings_route"
  | "prompt_expansion"
  /**
   * The slash maps onto a backend action that the chat send pipeline
   * dispatches per harness — e.g. `/compact` becomes Codex's
   * `thread/compact/start` RPC while still routing as `/compact` user input
   * on Claude Code. The handler returns the canonical action name; the
   * frontend resolves the active harness and either calls a dedicated
   * Tauri command, falls back to the normal send path, or short-circuits
   * with a local "not supported" message.
   */
  | "harness_action";

export interface SlashCommand {
  name: string;
  description: string;
  source: string;
  /** Alternative names for this canonical command. Empty for file-based entries. */
  aliases?: string[];
  /** Short hint describing expected argument shape, e.g. "[add|remove] <source>". */
  argument_hint?: string | null;
  /** Native command kind. Absent for file-based commands. */
  kind?: NativeSlashKind | null;
}

export function listSlashCommands(
  projectPath?: string,
  workspaceId?: string,
): Promise<SlashCommand[]> {
  return invoke("list_slash_commands", {
    projectPath: projectPath ?? null,
    workspaceId: workspaceId ?? null,
  });
}

export function recordSlashCommandUsage(
  workspaceId: string,
  commandName: string,
): Promise<void> {
  return invoke("record_slash_command_usage", {
    workspaceId,
    commandName,
  });
}
