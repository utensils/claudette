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

/** Returns true if `name` is the canonical name of a native handler. */
export function isNativeCanonicalName(
  name: string,
  handlers: NativeHandler[] = NATIVE_HANDLERS,
): boolean {
  return handlers.some((h) => h.name.toLowerCase() === name.toLowerCase());
}
