import type { PluginSettingsIntent } from "../../types/plugins";
import type { NativeSlashKind } from "../../services/tauri";
import { parsePluginSlashCommand } from "./pluginSlashCommand";

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
  openUsageSettingsExternal: () => void;
  openReleaseNotes: () => void;
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

export const NATIVE_HANDLERS: NativeHandler[] = [
  pluginHandler("plugin"),
  pluginHandler("marketplace"),
  reviewHandler("review", REVIEW_PROMPT),
  reviewHandler("security-review", SECURITY_REVIEW_PROMPT),
  reviewHandler("pr-comments", PR_COMMENTS_PROMPT),
  configHandler,
  usageHandler,
  extraUsageHandler,
  releaseNotesHandler,
  versionHandler,
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
