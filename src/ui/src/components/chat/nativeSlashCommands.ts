import type { PluginSettingsIntent } from "../../types/plugins";
import type { NativeSlashKind, SlashCommand } from "../../services/tauri";
import type { PermissionLevel } from "../../stores/useAppStore";
import { parsePluginSlashCommand } from "./pluginSlashCommand";
import { buildModelRegistry, resolveModelSelection } from "./modelRegistry";
import { useAppStore } from "../../stores/useAppStore";

export type { NativeSlashKind };

/** Valid section ids accepted by `/config <section>`. Mirrors the sections
 *  handled by `SettingsPage.tsx`. Unknown/empty sections fall back to `general`. */
export const CONFIG_SECTIONS = [
  "general",
  "models",
  "usage",
  "appearance",
  "notifications",
  "git",
  "plugins",
  "experimental",
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

export interface NativeCommandContext {
  repoId: string | null;
  pluginManagementEnabled: boolean;
  usageInsightsEnabled: boolean;
  openPluginSettings: (intent: Partial<PluginSettingsIntent>) => void;
  /** Repository metadata for the current workspace — used by review-workflow handlers. */
  repository: { name: string; path: string } | null;
  /** Workspace branch + worktree path for the current workspace. */
  workspace: { branch: string; worktreePath: string | null } | null;
  /**
   * Repo-level default branch (e.g. `origin/main`) when known. This is the
   * repository's default branch, NOT a guaranteed review base — a branch may
   * target a release/hotfix branch or be stacked on another feature branch.
   * Review-workflow prompts treat it as a hint and ask the agent to resolve
   * the real review base via git/gh.
   */
  repoDefaultBranch: string | null;
  openSettings: (section?: string) => void;
  appVersion: string | null;
  addLocalMessage: (text: string) => void;
  startClaudeAuthLogin: () => Promise<void>;
  openUsageSettingsExternal: () => void;
  openReleaseNotes: () => void;

  // -- Per-workspace state read by workspace-control commands
  // (/clear, /plan, /model, /permissions, /status). --
  workspaceId: string | null;
  agentStatus: string | null;
  selectedModel: string;
  selectedModelProvider: string;
  permissionLevel: PermissionLevel;
  planMode: boolean;
  fastMode: boolean;
  thinkingEnabled: boolean;
  chromeEnabled: boolean;
  effortLevel: string;
  planFilePath: string | null;

  // -- Pre-bound per-workspace write callbacks. Callers wire these to the
  // same store setters / backend commands the toolbar and shortcuts use. --
  setSelectedModel: (model: string, providerId?: string) => Promise<void>;
  setPermissionLevel: (level: PermissionLevel) => Promise<void>;
  setPlanMode: (enabled: boolean) => void;
  clearConversation: (restoreFiles: boolean) => Promise<void>;
  readPlanFile: (path: string) => Promise<string>;

  /**
   * Full slash command registry as exposed to the picker. Read by `/help`
   * so the help surface and the picker can never drift. Pass the same list
   * `list_slash_commands` returned for this workspace — do not reconstruct.
   */
  slashCommands: SlashCommand[];
}

export type NativeCommandResult =
  | { kind: "handled"; canonicalName: string }
  | { kind: "expand"; canonicalName: string; prompt: string }
  | { kind: "skipped" };

export interface NativeHandler {
  name: string;
  aliases: string[];
  kind: NativeSlashKind;
  execute: (
    ctx: NativeCommandContext,
    args: string,
  ) => NativeCommandResult | Promise<NativeCommandResult>;
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

/**
 * Detect a `/command` token at `cursor` inside multi-line `text`.
 *
 * A `/` triggers autocomplete when it sits at position 0 of the text or
 * immediately after a newline. Returns the token (text between `/` and the
 * next whitespace or end-of-input) plus the character range it occupies so
 * the caller can replace it on selection.
 */
export function describeSlashQueryAtCursor(
  text: string,
  cursor: number,
): { token: string; start: number; end: number } | null {
  const before = text.slice(0, cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const linePrefix = before.slice(lineStart);
  if (!linePrefix.startsWith("/")) return null;
  // Only the first word on the line qualifies — if there's whitespace
  // between the `/` and the cursor, the command token is closed.
  const tokenMatch = linePrefix.match(/^\/(\S*)$/);
  if (!tokenMatch) return null;
  // Extend end past the cursor so replacement covers the full token even when
  // the caret sits inside an existing `/command` (e.g. clicking into `/review`
  // halfway through). The token used for filtering stays the prefix up to the
  // cursor — that's what the user has committed to so far.
  let tokenEnd = cursor;
  while (tokenEnd < text.length && /\S/.test(text[tokenEnd] ?? "")) {
    tokenEnd += 1;
  }
  return {
    token: tokenMatch[1],
    start: lineStart,
    end: tokenEnd,
  };
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

/**
 * Build a workspace-grounded context block for review-style prompt expansions.
 *
 * Emits only the lines for fields that are populated, so missing metadata does
 * not leak `undefined` / `null` into the outgoing prompt.
 */
export function buildReviewContextBlock(ctx: NativeCommandContext): string {
  const lines: string[] = [];
  if (ctx.repository?.name) lines.push(`- Repository: ${ctx.repository.name}`);
  if (ctx.repository?.path) lines.push(`- Repository path: ${ctx.repository.path}`);
  if (ctx.workspace?.worktreePath) lines.push(`- Worktree: ${ctx.workspace.worktreePath}`);
  if (ctx.workspace?.branch) lines.push(`- Current branch: ${ctx.workspace.branch}`);
  if (ctx.repoDefaultBranch) {
    lines.push(
      `- Repo default branch (hint only — not guaranteed to be this branch's review base): ${ctx.repoDefaultBranch}`,
    );
  }
  return lines.join("\n");
}

function buildUserGuidanceBlock(args: string): string {
  const trimmed = args.trim();
  return trimmed ? `\n\nAdditional guidance from user: ${trimmed}` : "";
}

/**
 * Shared instruction block telling the agent how to resolve the actual review
 * base for the current branch. Repo default branch is only a fallback hint —
 * a branch may target a release/hotfix branch, or be stacked on another
 * feature branch, so the agent must check the upstream and PR metadata first.
 */
const RESOLVE_REVIEW_BASE_BLOCK = [
  "Resolve the review base ref before diffing. Prefer in this order:",
  "1. `gh pr view --json baseRefName -q .baseRefName` — if a PR exists, take that branch name and resolve it against the primary remote. Do NOT hardcode `origin/`; use `git remote` to find the actual remote name (may be `upstream` in fork workflows), then build `<remote>/<baseRefName>`.",
  "2. `git rev-parse --abbrev-ref @{upstream}` — only use this when the upstream clearly names the review target branch (for example, the branch's PR base). Do NOT use it when `@{upstream}` is just this branch's own remote-tracking ref (e.g. `origin/feat/x` while you are on `feat/x`) — that yields an empty diff.",
  "3. Otherwise, use the repo default branch listed in the context above as a fallback hint.",
  "4. If none of those yield a confident base ref, stop and ask the user which branch to review against.",
  "Call the resolved ref `<base>` in the rest of this task.",
].join("\n");

/**
 * Prompt for `/review` — general code review over the current branch's diff
 * vs. the base branch. Emphasizes correctness, regressions, risk, and tests.
 */
const REVIEW_PROMPT = [
  "Perform a focused code review of the current branch against its review base.",
  "",
  RESOLVE_REVIEW_BASE_BLOCK,
  "",
  "Review scope:",
  "- Run `git diff <base>...HEAD` (three dots) in the worktree above to see only this branch's changes.",
  "",
  "What to look for, in priority order:",
  "1. Correctness bugs and regressions in behavior.",
  "2. Risk: concurrency, error handling, migrations, security-adjacent changes.",
  "3. Test coverage for the changed behavior — are the interesting cases exercised?",
  "4. Clarity issues that could bite a future reader (hidden invariants, surprising control flow).",
  "",
  "Output format:",
  "- Group findings by file.",
  "- For each finding give: file:line, severity (high/medium/low), the issue, and a concrete suggestion.",
  "- End with a short overall summary and a ship / don't-ship recommendation.",
  "- Skip style nits and generic praise.",
].join("\n");

/**
 * Prompt for `/security-review` — security-focused review over the same diff.
 * Concrete high-signal findings only.
 */
const SECURITY_REVIEW_PROMPT = [
  "Perform a security-focused review of the current branch against its review base.",
  "",
  RESOLVE_REVIEW_BASE_BLOCK,
  "",
  "Review scope:",
  "- Run `git diff <base>...HEAD` (three dots) in the worktree above to see only this branch's changes.",
  "",
  "Focus areas (only report concrete, high-signal findings — no generic checklist output):",
  "- Authentication and authorization changes; privilege boundaries.",
  "- Untrusted input handling: injection (SQL, shell, path), deserialization, SSRF, XSS.",
  "- Secrets, credentials, tokens — leakage via logs, errors, responses, or commits.",
  "- Cryptography misuse (weak algorithms, hard-coded keys, bad randomness).",
  "- Unsafe dependencies, vulnerable patterns, or removed safety checks.",
  "- Logic flaws that change the security posture (rate limiting, CSRF, same-origin, etc.).",
  "",
  "Output format:",
  "- For each finding: file:line, severity (critical/high/medium/low), exploit scenario, fix.",
  "- If no security-relevant changes exist, say so plainly rather than padding.",
].join("\n");

/**
 * Prompt for `/pr-comments` — fetch and summarize PR comments for the current branch.
 * Users may pass an explicit PR number as the argument.
 */
const PR_COMMENTS_PROMPT = [
  "Fetch and summarize pull request comments for the current branch.",
  "",
  "Workflow:",
  "- If the user supplied a PR number in the additional guidance, use that PR directly.",
  "- Otherwise, resolve the PR for the current branch with `gh pr view --json number,url,title`.",
  "- Pull review comments with `gh pr view <number> --comments` and, when useful,",
  "  `gh api repos/{owner}/{repo}/pulls/{number}/comments` for inline review threads.",
  "",
  "Summary output:",
  "- Group by thread / reviewer.",
  "- For each comment: author, file:line (when inline), the ask, and whether it looks addressed on HEAD.",
  "- End with a short actionable punch list of unresolved items the user should respond to.",
  "- Skip bot noise and resolved threads unless they still contain open asks.",
].join("\n");

function reviewHandler(
  name: "review" | "security-review" | "pr-comments",
  template: string,
): NativeHandler {
  return {
    name,
    aliases: [],
    kind: "prompt_expansion",
    execute: (ctx, args) => {
      const header = [
        "You are reviewing work inside a Claudette workspace. Ground your review in this context:",
        buildReviewContextBlock(ctx),
      ]
        .filter((section) => section.length > 0)
        .join("\n");
      const prompt = `${header}\n\n${template}${buildUserGuidanceBlock(args)}`;
      return { kind: "expand", canonicalName: name, prompt };
    },
  };
}

const configHandler: NativeHandler = {
  name: "config",
  aliases: ["configure"],
  kind: "settings_route",
  execute: (ctx, args) => {
    const first = args.trim().split(/\s+/, 1)[0] ?? "";
    const lowered = first.toLowerCase();
    const validSection = (CONFIG_SECTIONS as readonly string[]).includes(lowered)
      ? (lowered as ConfigSection)
      : "general";
    // Respect the Usage Insights experimental gate: when the user hasn't
    // opted in, the settings sidebar hides the Usage row, so `/config usage`
    // should land on Experimental where the toggle lives instead of silently
    // opening the hidden page.
    const section =
      validSection === "usage" && !ctx.usageInsightsEnabled
        ? "experimental"
        : validSection;
    ctx.openSettings(section);
    return { kind: "handled", canonicalName: "config" };
  },
};

const usageHandler: NativeHandler = {
  name: "usage",
  aliases: [],
  kind: "settings_route",
  execute: (ctx) => {
    // Mirror `/config usage` — route to Experimental when the gate is off.
    ctx.openSettings(ctx.usageInsightsEnabled ? "usage" : "experimental");
    return { kind: "handled", canonicalName: "usage" };
  },
};

function formatCommandError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const loginHandler: NativeHandler = {
  name: "login",
  aliases: [],
  kind: "local_action",
  execute: async (ctx, args) => {
    const handled = { kind: "handled" as const, canonicalName: "login" };
    if (args.trim() !== "") {
      ctx.addLocalMessage("/login: does not accept arguments. Usage: /login");
      return handled;
    }
    try {
      await ctx.startClaudeAuthLogin();
      ctx.addLocalMessage(
        "Claude Code sign-in opened. Complete the browser flow, then retry the turn.",
      );
    } catch (error) {
      ctx.addLocalMessage(`/login failed: ${formatCommandError(error)}`);
    }
    return handled;
  },
};

const extraUsageHandler: NativeHandler = {
  name: "extra-usage",
  aliases: [],
  kind: "settings_route",
  execute: (ctx) => {
    if (!ctx.usageInsightsEnabled) {
      // Gate off: do not surface the hidden panel and do not launch claude.ai.
      // Send the user to Experimental where they can opt in first.
      ctx.openSettings("experimental");
      return { kind: "handled", canonicalName: "extra-usage" };
    }
    // Reuse the in-app usage panel (which shows extra-usage status and a
    // Manage/Enable link) and deep-link to claude.ai settings so the user can
    // toggle extra usage immediately in either state.
    ctx.openSettings("usage");
    ctx.openUsageSettingsExternal();
    return { kind: "handled", canonicalName: "extra-usage" };
  },
};

const releaseNotesHandler: NativeHandler = {
  name: "release-notes",
  aliases: ["changelog"],
  kind: "local_action",
  execute: (ctx) => {
    ctx.openReleaseNotes();
    return { kind: "handled", canonicalName: "release-notes" };
  },
};

/** Format the text shown by `/version`. Exported for testing. */
export function formatVersionMessage(version: string | null): string {
  return `Claudette v${version ?? "unknown"}`;
}

const versionHandler: NativeHandler = {
  name: "version",
  aliases: ["about"],
  kind: "local_action",
  execute: (ctx) => {
    ctx.addLocalMessage(formatVersionMessage(ctx.appVersion));
    return { kind: "handled", canonicalName: "version" };
  },
};

const PERMISSION_MODES: PermissionLevel[] = ["readonly", "standard", "full"];

function isPermissionLevel(value: string): value is PermissionLevel {
  return (PERMISSION_MODES as string[]).includes(value);
}

function formatOnOff(enabled: boolean): string {
  return enabled ? "on" : "off";
}

const clearHandler: NativeHandler = {
  name: "clear",
  aliases: [],
  kind: "local_action",
  execute: async (ctx, args) => {
    const handled = { kind: "handled" as const, canonicalName: "clear" };
    if (!ctx.workspaceId) {
      ctx.addLocalMessage("/clear: no active workspace");
      return handled;
    }
    if (args.trim() !== "") {
      ctx.addLocalMessage("/clear: does not accept arguments. Usage: /clear");
      return handled;
    }
    try {
      // Chat history only — file restore is available from the rollback modal
      // when the user explicitly wants it.
      await ctx.clearConversation(false);
      ctx.addLocalMessage("Conversation cleared.");
    } catch (error) {
      ctx.addLocalMessage(`/clear failed: ${String(error)}`);
    }
    return handled;
  },
};

const compactHandler: NativeHandler = {
  name: "compact",
  aliases: [],
  kind: "prompt_expansion",
  execute: (ctx, args) => {
    if (!ctx.workspaceId) {
      ctx.addLocalMessage("/compact: no active workspace");
      return { kind: "handled" as const, canonicalName: "compact" };
    }
    if (args.trim() !== "") {
      ctx.addLocalMessage("/compact: does not accept arguments. Usage: /compact");
      return { kind: "handled" as const, canonicalName: "compact" };
    }
    return { kind: "expand" as const, canonicalName: "compact", prompt: "/compact" };
  },
};

const planHandler: NativeHandler = {
  name: "plan",
  aliases: [],
  kind: "local_action",
  execute: async (ctx, args) => {
    const handled = { kind: "handled" as const, canonicalName: "plan" };
    if (!ctx.workspaceId) {
      ctx.addLocalMessage("/plan: no active workspace");
      return handled;
    }
    const arg = args.trim().toLowerCase();
    if (arg === "" || arg === "toggle") {
      const next = !ctx.planMode;
      ctx.setPlanMode(next);
      ctx.addLocalMessage(`Plan mode ${formatOnOff(next)}.`);
      return handled;
    }
    if (arg === "on") {
      ctx.setPlanMode(true);
      ctx.addLocalMessage("Plan mode enabled.");
      return handled;
    }
    if (arg === "off") {
      ctx.setPlanMode(false);
      ctx.addLocalMessage("Plan mode disabled.");
      return handled;
    }
    if (arg === "open") {
      if (!ctx.planFilePath) {
        ctx.addLocalMessage(
          "/plan open: no plan file found for this workspace. Enable plan mode and run a turn to produce one.",
        );
        return handled;
      }
      try {
        const content = await ctx.readPlanFile(ctx.planFilePath);
        // Emit as markdown so the renderer surfaces headings, lists, and code
        // fences inside the plan instead of collapsing it into one paragraph.
        // The path line is rendered as italic muted metadata above the body.
        ctx.addLocalMessage(
          `_Plan file — \`${ctx.planFilePath}\`_\n\n${content}`,
        );
      } catch (error) {
        ctx.addLocalMessage(`/plan open failed: ${String(error)}`);
      }
      return handled;
    }
    ctx.addLocalMessage(
      "/plan: unknown argument. Usage: /plan [on|off|toggle|open]",
    );
    return handled;
  },
};

const modelHandler: NativeHandler = {
  name: "model",
  aliases: [],
  kind: "local_action",
  execute: async (ctx, args) => {
    const handled = { kind: "handled" as const, canonicalName: "model" };
    if (!ctx.workspaceId) {
      ctx.addLocalMessage("/model: no active workspace");
      return handled;
    }
    const { disable1mContext } = useAppStore.getState();
    const { alternativeBackendsEnabled, experimentalCodexEnabled, agentBackends } = useAppStore.getState();
    const registry = buildModelRegistry(
      alternativeBackendsEnabled,
      agentBackends,
      experimentalCodexEnabled,
    );
    const available = disable1mContext
      ? registry.filter((m) => m.contextWindowTokens < 1_000_000)
      : registry;
    const arg = args.trim();
    const modelIds = available.map((m) => m.providerQualifiedId ?? m.id);
    if (arg === "") {
      const lines = available.map((m) => {
        const provider = m.providerId ?? "anthropic";
        const marker = m.id === ctx.selectedModel && provider === ctx.selectedModelProvider ? "•" : " ";
        const id = m.providerQualifiedId ?? m.id;
        return ` ${marker} ${id} — ${m.label}`;
      }).join("\n");
      ctx.addLocalMessage(`Current model: ${ctx.selectedModel}\n${lines}`);
      return handled;
    }
    const match = resolveModelSelection(available, arg);
    if (!match) {
      ctx.addLocalMessage(
        `/model: unknown model "${arg}". Valid options: ${modelIds.join(", ")}`,
      );
      return handled;
    }
    const provider = match.providerId ?? "anthropic";
    if (match.id === ctx.selectedModel && provider === ctx.selectedModelProvider) {
      ctx.addLocalMessage(`Model is already ${match.id}.`);
      return handled;
    }
    try {
      await ctx.setSelectedModel(match.id, provider);
      ctx.addLocalMessage(`Model set to ${match.providerQualifiedId ?? match.id}.`);
    } catch (error) {
      ctx.addLocalMessage(`/model failed: ${String(error)}`);
    }
    return handled;
  },
};

const permissionsHandler: NativeHandler = {
  name: "permissions",
  aliases: ["allowed-tools"],
  kind: "local_action",
  execute: async (ctx, args) => {
    const handled = {
      kind: "handled" as const,
      canonicalName: "permissions",
    };
    if (!ctx.workspaceId) {
      ctx.addLocalMessage("/permissions: no active workspace");
      return handled;
    }
    const arg = args.trim().toLowerCase();
    if (arg === "") {
      ctx.addLocalMessage(
        `Permission mode: ${ctx.permissionLevel}. Options: ${PERMISSION_MODES.join(", ")}`,
      );
      return handled;
    }
    if (!isPermissionLevel(arg)) {
      ctx.addLocalMessage(
        `/permissions: unknown mode "${args.trim()}". Valid options: ${PERMISSION_MODES.join(", ")}`,
      );
      return handled;
    }
    if (arg === ctx.permissionLevel) {
      ctx.addLocalMessage(`Permission mode is already ${arg}.`);
      return handled;
    }
    try {
      await ctx.setPermissionLevel(arg);
      ctx.addLocalMessage(`Permission mode set to ${arg}.`);
    } catch (error) {
      ctx.addLocalMessage(`/permissions failed: ${String(error)}`);
    }
    return handled;
  },
};

/**
 * Seed prompt for `/init` — repo-bootstrap workflow. The seeded text is sent
 * through the normal agent pipeline so the agent can inspect the codebase and
 * write or update `CLAUDE.md` via the standard tool flow. Existing `CLAUDE.md`
 * content must be merged, not overwritten, so mature repos don't lose guidance.
 */
const INIT_PROMPT = [
  "Bootstrap project guidance for this repository.",
  "",
  "Goal: produce or update a repo-level `CLAUDE.md` at the repo root that is useful to a future agent (or engineer) who has never seen this codebase. If `CLAUDE.md` already exists, MERGE new findings into it — preserve existing guidance, only add or refine.",
  "",
  "Inspection pass (do this first):",
  "- Identify the project type, primary languages, and frameworks.",
  "- Find the build, test, lint, and format commands (look at package.json, Cargo.toml, Makefile, flake.nix, pyproject.toml, etc.).",
  "- Map the top-level directory structure and what each area is for.",
  "- Note the commit convention (scan `git log --oneline -20`).",
  "- Note any code-style config (rustfmt, prettier, ruff, .editorconfig) and the stance it encodes.",
  "- Detect any existing `.claudette.json` or similar instruction files — cross-reference so CLAUDE.md doesn't contradict them.",
  "",
  "CLAUDE.md should include, in this order:",
  "1. One-paragraph project summary.",
  "2. Build & test commands as copy-paste shell snippets.",
  "3. Code style conventions the repo actually uses.",
  "4. Commit conventions (e.g. Conventional Commits, PR title rules).",
  "5. Architecture overview: crates/modules/packages and their responsibilities.",
  "6. Project structure tree (pruned — skip node_modules, target, dist, etc.).",
  "7. Guidelines for new code (where data types live, where commands live, state conventions).",
  "8. Debugging / dev loop notes if the repo has non-trivial dev tooling.",
  "",
  "Rules:",
  "- Write the file via the normal file-write tool flow.",
  "- Do not commit or push.",
  "- If a `CLAUDE.md` already exists, read it first and preserve sections the user has clearly authored (custom conventions, team rules). Only update sections that are stale or missing.",
  "- Keep the file concise and high-signal; this is agent instruction material, not marketing copy.",
].join("\n");

const initHandler: NativeHandler = {
  name: "init",
  aliases: [],
  kind: "prompt_expansion",
  execute: (ctx, args) => {
    const lines: string[] = [];
    if (ctx.repository?.name) lines.push(`- Repository: ${ctx.repository.name}`);
    if (ctx.repository?.path) lines.push(`- Repository path: ${ctx.repository.path}`);
    if (ctx.workspace?.worktreePath) lines.push(`- Worktree: ${ctx.workspace.worktreePath}`);
    if (ctx.workspace?.branch) lines.push(`- Current branch: ${ctx.workspace.branch}`);
    if (ctx.repoDefaultBranch)
      lines.push(`- Repo default branch (hint): ${ctx.repoDefaultBranch}`);
    const contextBlock = lines.length > 0 ? `\n\nWorkspace context:\n${lines.join("\n")}` : "";
    const prompt = `${INIT_PROMPT}${contextBlock}${buildUserGuidanceBlock(args)}`;
    return { kind: "expand", canonicalName: "init", prompt };
  },
};

function formatCommandLine(
  cmd: SlashCommand,
  shadowedAliases: ReadonlySet<string>,
): string {
  // Wrap the command invocation in inline code so angle-bracket placeholders
  // like `<source>` and `<model>` survive the markdown pipeline intact —
  // rehype-raw otherwise parses them as HTML tags and either drops them via
  // rehype-sanitize or renders them as self-closing tags. Inline code also
  // gives /help a consistent visual anchor in the chat transcript.
  const head = cmd.argument_hint
    ? `\`/${cmd.name} ${cmd.argument_hint}\``
    : `\`/${cmd.name}\``;

  // Drop aliases that a file-based user/project command has shadowed. The
  // dispatcher in ChatPanel.handleSend treats typing such an alias as a
  // file-based invocation, so /help advertising it as "(alias: …)" for the
  // native would be misleading. Aliases owned by the native (no file-based
  // collision) render normally.
  const visibleAliases = (cmd.aliases ?? []).filter(
    (alias) => !shadowedAliases.has(alias.toLowerCase()),
  );
  const aliasPart =
    visibleAliases.length > 0
      ? `  (alias: ${visibleAliases.map((a) => `/${a}`).join(", ")})`
      : "";
  const desc = cmd.description.trim().length > 0 ? ` — ${cmd.description}` : "";
  return `- ${head}${aliasPart}${desc}`;
}

/**
 * Build the multi-line `/help` output. Pure function so tests can pin exact
 * formatting without spinning up a context.
 *
 * Layout:
 *   **Native commands**
 *   _Actions (stay local, do not contact the agent)_
 *     - /clear — ...
 *   _Settings shortcuts_
 *     - /config [...] — ...
 *   _Prompt expansions (seed a prompt, then send to the agent)_
 *     - /review [...] — ...
 *   **Project commands** / **User commands** / **Plugin commands**
 *
 * Native entries are grouped by `kind`. File-based entries are grouped by
 * `source`. Each group is alphabetized. Empty groups are omitted entirely so
 * the output stays tight when plugin/project commands don't apply.
 */
export function formatHelpMessage(commands: SlashCommand[]): string {
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));

  // Names claimed by a user/project markdown command shadow any colliding
  // native alias in ChatPanel's dispatcher, so /help must suppress those
  // alias lines to stay consistent with actual routing behavior.
  const shadowedAliases: ReadonlySet<string> = new Set(
    sorted
      .filter((c) => c.source === "user" || c.source === "project")
      .map((c) => c.name.toLowerCase()),
  );

  const byKind = new Map<NativeSlashKind, SlashCommand[]>();
  const bySource: Record<"project" | "user" | "plugin", SlashCommand[]> = {
    project: [],
    user: [],
    plugin: [],
  };

  for (const cmd of sorted) {
    if (cmd.source === "builtin") {
      const kind = cmd.kind ?? null;
      if (!kind) continue;
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind)!.push(cmd);
    } else if (cmd.source === "project" || cmd.source === "user" || cmd.source === "plugin") {
      bySource[cmd.source].push(cmd);
    }
  }

  const sections: string[] = [];
  const nativeLines: string[] = [];

  const kindOrder: Array<{ kind: NativeSlashKind; heading: string }> = [
    {
      kind: "local_action",
      heading: "_Actions (stay local, do not contact the agent)_",
    },
    { kind: "settings_route", heading: "_Settings shortcuts_" },
    {
      kind: "prompt_expansion",
      heading: "_Prompt expansions (seed a prompt, then send to the agent)_",
    },
  ];

  for (const { kind, heading } of kindOrder) {
    const entries = byKind.get(kind);
    if (!entries || entries.length === 0) continue;
    nativeLines.push(heading);
    entries.forEach((cmd) => nativeLines.push(formatCommandLine(cmd, shadowedAliases)));
    nativeLines.push("");
  }

  if (nativeLines.length > 0) {
    // Drop trailing blank line from the native block before emitting.
    while (nativeLines.length > 0 && nativeLines[nativeLines.length - 1] === "") {
      nativeLines.pop();
    }
    sections.push(["**Native commands**", "", ...nativeLines].join("\n"));
  }

  const sourceOrder: Array<{ key: "project" | "user" | "plugin"; heading: string }> = [
    { key: "project", heading: "**Project commands**" },
    { key: "user", heading: "**User commands**" },
    { key: "plugin", heading: "**Plugin commands**" },
  ];

  for (const { key, heading } of sourceOrder) {
    const entries = bySource[key];
    if (entries.length === 0) continue;
    const block = [heading, "", ...entries.map((cmd) => formatCommandLine(cmd, shadowedAliases))];
    sections.push(block.join("\n"));
  }

  if (sections.length === 0) {
    return "No slash commands are registered.";
  }

  return sections.join("\n\n");
}

const helpHandler: NativeHandler = {
  name: "help",
  aliases: [],
  kind: "local_action",
  execute: (ctx) => {
    ctx.addLocalMessage(formatHelpMessage(ctx.slashCommands));
    return { kind: "handled", canonicalName: "help" };
  },
};

const statusHandler: NativeHandler = {
  name: "status",
  aliases: [],
  kind: "local_action",
  execute: (ctx) => {
    const handled = { kind: "handled" as const, canonicalName: "status" };
    if (!ctx.workspaceId) {
      ctx.addLocalMessage("/status: no active workspace");
      return handled;
    }
    const repo = ctx.repository?.name ?? "(unknown repo)";
    const branch = ctx.workspace?.branch ?? "(no branch)";
    const agent = ctx.agentStatus ?? "(unknown)";
    const lines = [
      `Repo: ${repo}`,
      `Branch: ${branch}`,
      `Agent: ${agent}`,
      `Model: ${ctx.selectedModel}`,
      `Permission: ${ctx.permissionLevel}`,
      `Plan mode: ${formatOnOff(ctx.planMode)}`,
      `Fast: ${formatOnOff(ctx.fastMode)}`,
      `Thinking: ${formatOnOff(ctx.thinkingEnabled)}`,
      `Chrome: ${formatOnOff(ctx.chromeEnabled)}`,
      `Effort: ${ctx.effortLevel}`,
    ];
    ctx.addLocalMessage(lines.join("\n"));
    return handled;
  },
};

export const NATIVE_HANDLERS: NativeHandler[] = [
  pluginHandler("plugin"),
  pluginHandler("marketplace"),
  reviewHandler("review", REVIEW_PROMPT),
  reviewHandler("security-review", SECURITY_REVIEW_PROMPT),
  reviewHandler("pr-comments", PR_COMMENTS_PROMPT),
  configHandler,
  usageHandler,
  loginHandler,
  extraUsageHandler,
  releaseNotesHandler,
  versionHandler,
  clearHandler,
  compactHandler,
  planHandler,
  modelHandler,
  permissionsHandler,
  statusHandler,
  helpHandler,
  initHandler,
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
