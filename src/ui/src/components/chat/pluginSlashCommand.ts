import type {
  EditablePluginScope,
  PluginSettingsIntent,
} from "../../types/plugins";

export interface ParsedPluginSlashCommand {
  usageCommandName: "plugin" | "marketplace";
  intent: PluginSettingsIntent;
}

export function isPluginSlashCommandInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return false;

  const root = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase();
  return root === "plugin" || root === "plugins" || root === "marketplace";
}

export function parsePluginSlashCommand(
  input: string,
  repoId: string | null,
  enabled = true,
): ParsedPluginSlashCommand | null {
  if (!enabled) return null;

  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const tokens = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const root = tokens[0]?.toLowerCase();
  if (root !== "plugin" && root !== "plugins" && root !== "marketplace") {
    return null;
  }

  if (root === "marketplace") {
    return {
      usageCommandName: "marketplace",
      intent: parseMarketplaceIntent(tokens.slice(1), repoId),
    };
  }

  const subcommand = tokens[1]?.toLowerCase();
  if (!subcommand || subcommand === "help") {
    return {
      usageCommandName: "plugin",
      intent: {
        action: null,
        repoId,
        scope: "user",
        source: null,
        tab: "available",
        target: null,
      },
    };
  }

  if (subcommand === "marketplace") {
    return {
      usageCommandName: "plugin",
      intent: parseMarketplaceIntent(tokens.slice(2), repoId),
    };
  }

  if (subcommand === "manage") {
    return {
      usageCommandName: "plugin",
      intent: {
        action: null,
        repoId,
        scope: "user",
        source: null,
        tab: "installed",
        target: null,
      },
    };
  }

  if (subcommand === "available" || subcommand === "browse" || subcommand === "discover") {
    return {
      usageCommandName: "plugin",
      intent: {
        action: null,
        repoId,
        scope: readScope(tokens, "user"),
        source: null,
        tab: "available",
        target: findFirstPositional(tokens.slice(2)),
      },
    };
  }

  const scope = readScope(tokens, "user");
  const target = findFirstPositional(tokens.slice(2));
  const action = normalizePluginAction(subcommand);
  if (!action) return null;

  return {
    usageCommandName: "plugin",
    intent: {
      action,
      repoId,
      scope,
      source: action === "install" ? target : null,
      tab: action === "install" ? "available" : "installed",
      target: action === "install" ? null : target,
    },
  };
}

function parseMarketplaceIntent(
  tokens: string[],
  repoId: string | null,
): PluginSettingsIntent {
  const actionToken = tokens[0]?.toLowerCase();
  const scope = readScope(tokens, "user");
  const positional = findFirstPositional(tokens.slice(1));
  const action =
    actionToken === "add"
      ? "marketplace-add"
      : actionToken === "remove" || actionToken === "rm"
        ? "marketplace-remove"
        : actionToken === "update"
          ? "marketplace-update"
          : null;

  return {
    action,
    repoId,
    scope,
    source: action === "marketplace-add" ? positional : null,
    tab: "marketplaces",
    target:
      action === "marketplace-remove" || action === "marketplace-update"
        ? positional
        : null,
  };
}

function normalizePluginAction(
  action: string,
): PluginSettingsIntent["action"] | null {
  switch (action) {
    case "install":
    case "enable":
    case "disable":
    case "uninstall":
    case "update":
      return action;
    case "remove":
      return "uninstall";
    default:
      return null;
  }
}

function readScope(
  tokens: string[],
  fallback: EditablePluginScope,
): EditablePluginScope {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]?.toLowerCase();
    if ((token === "--scope" || token === "-s")
      && isEditableScope(tokens[index + 1])) {
      return tokens[index + 1] as EditablePluginScope;
    }
  }
  return fallback;
}

function findFirstPositional(tokens: string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--scope" || token === "-s") {
      index += 1;
      continue;
    }
    if (!token.startsWith("-")) return token;
  }
  return null;
}

function isEditableScope(scope: string | undefined): scope is EditablePluginScope {
  return scope === "user" || scope === "project" || scope === "local";
}
