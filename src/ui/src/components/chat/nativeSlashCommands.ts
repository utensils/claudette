import type { PluginSettingsIntent } from "../../types/plugins";
import type { NativeSlashKind } from "../../services/tauri";
import { parsePluginSlashCommand } from "./pluginSlashCommand";

export type { NativeSlashKind };

export interface NativeCommandContext {
  repoId: string | null;
  pluginManagementEnabled: boolean;
  openPluginSettings: (intent: Partial<PluginSettingsIntent>) => void;
}

export type NativeCommandResult =
  | { kind: "handled"; canonicalName: string }
  | { kind: "expand"; canonicalName: string; prompt: string }
  | { kind: "skipped" };

export interface NativeHandler {
  name: string;
  aliases: string[];
  kind: NativeSlashKind;
  execute: (ctx: NativeCommandContext, args: string) => NativeCommandResult;
}

/** Split `/token rest of args` into its token and the argument tail. */
export function parseSlashInput(
  input: string,
): { token: string; args: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const match = body.match(/^(\S+)(\s+([\s\S]*))?$/);
  if (!match) return null;
  const token = match[1];
  const args = match[3] ?? "";
  return { token, args };
}

/**
 * Describe the slash picker query derived from the current chat input.
 *
 * - `token` is the text between the leading `/` and the first whitespace.
 *   Use it for picker filtering so the picker stays open while the user
 *   types arguments after the command name.
 * - `hasArgs` is true if any whitespace follows the token — used by the
 *   picker to decide whether Enter should replace the input with the
 *   canonical name or preserve the user's typed arguments.
 * - Returns `null` if the input is not a slash command.
 */
export function describeSlashQuery(
  input: string,
): { token: string; hasArgs: boolean } | null {
  if (!input.startsWith("/")) return null;
  const rest = input.slice(1);
  const match = rest.match(/^(\S*)(\s([\s\S]*))?$/);
  if (!match) return null;
  return { token: match[1] ?? "", hasArgs: match[2] !== undefined };
}

function pluginHandler(root: "plugin" | "marketplace"): NativeHandler {
  return {
    name: root,
    aliases: root === "plugin" ? ["plugins"] : [],
    kind: "settings_route",
    execute: (ctx, args) => {
      if (!ctx.pluginManagementEnabled) {
        // Plugin management disabled — swallow the command so it never reaches
        // the agent, but do not mutate settings.
        return { kind: "handled", canonicalName: root };
      }
      const reconstructed = args.length > 0 ? `/${root} ${args}` : `/${root}`;
      const parsed = parsePluginSlashCommand(
        reconstructed,
        ctx.repoId,
        ctx.pluginManagementEnabled,
      );
      if (!parsed) {
        return { kind: "handled", canonicalName: root };
      }
      ctx.openPluginSettings(parsed.intent);
      return { kind: "handled", canonicalName: parsed.usageCommandName };
    },
  };
}

export const NATIVE_HANDLERS: NativeHandler[] = [
  pluginHandler("plugin"),
  pluginHandler("marketplace"),
];

/** Resolve a slash command token (no leading `/`) against the native handler table. */
export function resolveNativeHandler(
  token: string,
  handlers: NativeHandler[] = NATIVE_HANDLERS,
): NativeHandler | null {
  const needle = token.trim().toLowerCase();
  if (!needle) return null;
  return (
    handlers.find(
      (h) =>
        h.name.toLowerCase() === needle
        || h.aliases.some((a) => a.toLowerCase() === needle),
    ) ?? null
  );
}

