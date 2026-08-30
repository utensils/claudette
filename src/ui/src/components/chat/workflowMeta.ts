/**
 * Pull a stable display name and description for a `Workflow` tool call out
 * of its input JSON.
 *
 * Why not use the streamed `description`? On `task_progress` the CLI sets it
 * to the *currently running agent* (`"Review: review:completeness"`), so it
 * churns every few seconds. That makes a good live subtitle and a terrible
 * title. The tool input, by contrast, is available the moment the tool_use
 * arrives — before any progress event — and never changes.
 *
 * Resolution order: an explicit `name` (saved/named workflow) → the `meta`
 * block inside an inline `script` → the `scriptPath` basename → `"Workflow"`.
 */

/** Upper bound on the `meta` literal scan, so a script with an unbalanced
 *  brace (or one that simply never closes the object) can't walk the whole
 *  file. Real `meta` blocks are a few hundred chars; measured against a
 *  corpus of real runs, whole scripts are a median of ~10 KB and up to
 *  ~30 KB. */
const META_SCAN_CHARS = 4000;

interface WorkflowToolInput {
  name?: unknown;
  script?: unknown;
  scriptPath?: unknown;
  resumeFromRunId?: unknown;
}

function parseInput(inputJson: string): WorkflowToolInput | null {
  try {
    const parsed: unknown = JSON.parse(inputJson || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as WorkflowToolInput;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Slice out the `meta = { … }` object literal, brace-matched.
 *
 * Bounding the search to the literal itself is what stops a `name:` further
 * down the script (an agent option, a schema property, an array of named
 * dimensions) from being read as the workflow's name. A fixed character
 * window can't do that — `meta` is often followed immediately by exactly
 * such a declaration.
 *
 * The scan skips over quoted strings so a brace inside a description
 * (`'emit {n} findings'`) doesn't close the object early. `meta` is
 * contractually a pure literal, so there are no comments, regexes, or
 * template interpolations to worry about.
 *
 * Returns null if the literal is absent or never closes within
 * `META_SCAN_CHARS`.
 */
function extractMetaLiteral(script: string): string | null {
  const header = /export\s+const\s+meta\s*=\s*\{/.exec(script);
  if (!header) return null;

  const open = header.index + header[0].length - 1;
  const limit = Math.min(script.length, open + META_SCAN_CHARS);
  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < limit; i++) {
    const ch = script[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return script.slice(open, i + 1);
    }
  }
  return null;
}

/** Read one string property out of the workflow's `meta` literal.
 *
 *  A regex rather than a parser, applied to the brace-matched literal only:
 *  `meta` is contractually pure, and a failed match degrades to the next
 *  fallback rather than to a wrong answer. */
function readMetaString(script: string, key: string): string | null {
  const meta = extractMetaLiteral(script);
  if (!meta) return null;
  // Single, double, or backtick quotes — `meta` literals in the wild use all
  // three. The value class excludes all three quote characters, so an
  // interpolated backtick value (`${...}`) simply fails to match and falls
  // through instead of resolving to something wrong.
  const match = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`).exec(meta);
  const value = match?.[2]?.trim();
  return value ? value : null;
}

/** Basename of a script path, minus the `-wf_<runId>` suffix and extension
 *  that `Workflow` appends when it persists an inline script. */
function scriptPathName(scriptPath: string): string | null {
  const base = scriptPath.split(/[/\\]/).pop() ?? "";
  const withoutExt = base.replace(/\.[cm]?js$/, "");
  const withoutRunId = withoutExt.replace(/-wf_[A-Za-z0-9-]+$/, "");
  return withoutRunId.trim() || null;
}

/** Stable title for a workflow tool call. Never empty. */
export function workflowDisplayName(inputJson: string): string {
  const input = parseInput(inputJson);
  if (!input) return "Workflow";

  const explicitName = nonEmptyString(input.name);
  if (explicitName) return explicitName;

  const script = nonEmptyString(input.script);
  if (script) {
    const metaName = readMetaString(script, "name");
    if (metaName) return metaName;
  }

  const scriptPath = nonEmptyString(input.scriptPath);
  if (scriptPath) {
    const fromPath = scriptPathName(scriptPath);
    if (fromPath) return fromPath;
  }

  return "Workflow";
}

/** One-line description from `meta.description`, or null when the workflow
 *  was launched by name / path (where we have no script to read). */
export function workflowDescription(inputJson: string): string | null {
  const input = parseInput(inputJson);
  const script = input ? nonEmptyString(input.script) : null;
  if (!script) return null;
  return readMetaString(script, "description");
}

/** True when this invocation resumed a prior run rather than starting fresh.
 *  Worth surfacing because a resumed run's cached agents complete instantly,
 *  which otherwise looks like an implausibly fast workflow. */
export function isWorkflowResume(inputJson: string): boolean {
  const input = parseInput(inputJson);
  return !!input && nonEmptyString(input.resumeFromRunId) !== null;
}

/** Prefix of the `Workflow` tool's background-launch announcement. Mirrors
 *  `parse_workflow_task_binding` in `src/agent/background.rs`, which Rust
 *  uses to arm the background-task wake off the same string. */
const WORKFLOW_LAUNCH_PREFIX = "Workflow launched in background. Task ID:";

/**
 * The task id a `Workflow` tool result announces, or null when it announces
 * none.
 *
 * Null is the load-bearing answer: a `Workflow` call that errored, was
 * rejected, or returned without starting anything emits no
 * `task_notification` either, so nothing downstream would ever resolve it and
 * its status pill would read `· starting` until the app restarted. Absence of
 * a task id is the positive signal that there is no run to wait for.
 *
 * Deliberately the same string contract Rust already depends on rather than a
 * looser heuristic: `parse_workflow_task_binding` arms the wake off this exact
 * announcement, so if the wording ever changes, the wake breaks in the same
 * release this does — one failure to notice, not two.
 */
export function workflowLaunchTaskId(resultText: string): string | null {
  const at = resultText.indexOf(WORKFLOW_LAUNCH_PREFIX);
  if (at < 0) return null;
  const rest = resultText.slice(at + WORKFLOW_LAUNCH_PREFIX.length).trimStart();
  // First whitespace-delimited token, minus a trailing sentence period —
  // the announcement appears both as `Task ID: w1\nSummary: …` and as
  // `Task ID: w1.`
  const id = (rest.split(/\s/)[0] ?? "").replace(/\.+$/, "");
  return id || null;
}
