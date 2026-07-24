import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { ToolActivity } from "../../stores/useAppStore";
import {
  isAgentTerminal,
  phaseTitleOf,
  readOptionalString,
  summarizeWorkflowProgress,
  type WorkflowAgentEntry,
} from "../../types/workflow";
import { formatDurationMs } from "./chatHelpers";
import { formatTokens } from "./formatTokens";
import {
  isWorkflowResume,
  workflowDescription,
  workflowDisplayName,
} from "./workflowMeta";
import { WORKFLOW_CARD_ANCHOR_ATTR } from "./workflowAnchor";
import styles from "./WorkflowCard.module.css";

/** Grouping key for an agent with no phase — workflows can call `agent()`
 *  before any `phase()`, and those still need a home in the tree. */
const UNPHASED = "__claudette_unphased__";

/** Read the inline `script` back out of the tool input.
 *
 *  Kept reachable because it used to be: before this card existed a
 *  workflow rendered through `ToolActivityRow`, whose expanded view showed
 *  the script. Returns null for workflows launched by `name` or
 *  `scriptPath`, where there is no inline source to show. */
function workflowScript(inputJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(inputJson || "{}");
    if (!parsed || typeof parsed !== "object") return null;
    const script = (parsed as { script?: unknown }).script;
    return typeof script === "string" && script.trim() ? script : null;
  } catch {
    return null;
  }
}

/** Statuses that mean the background task itself has ended.
 *
 *  These arrive on the `task-notification` the CLI emits when a workflow
 *  finishes — `useAgentStream` copies the notification's `status` onto
 *  `agentStatus`. While the run is in flight the same field reads
 *  `"running"` (set by the `task_progress` branch). */
const TERMINAL_WORKFLOW_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "killed",
  "cancelled",
  "canceled",
]);

function isTerminalWorkflowStatus(status: string | null | undefined): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has((status ?? "").toLowerCase());
}

function stateIcon(state: string): string {
  switch (state) {
    case "done":
      return "●";
    case "error":
      return "✕";
    case "progress":
      return "◐";
    default:
      // Covers "queued" and any state we don't recognize — both mean
      // "hasn't produced anything yet" as far as the reader is concerned.
      return "○";
  }
}

function stateClass(state: string): string {
  switch (state) {
    case "done":
      return styles.stateDone;
    case "error":
      return styles.stateError;
    case "progress":
      return styles.stateProgress;
    default:
      return styles.stateQueued;
  }
}

/**
 * Elapsed milliseconds for one agent.
 *
 * A finished agent reports `durationMs` and we use it verbatim.
 *
 * A running one doesn't — and its `lastProgressAt` only advances when the
 * CLI sends a tick, which is throttled to once every 10s for a workflow
 * that is otherwise just working. Reading elapsed off the last tick would
 * make every in-flight row look frozen for ten seconds at a stretch, so a
 * live row interpolates from `startedAt` against the local clock instead.
 *
 * `live` gates that interpolation, and the gate is load-bearing: a run
 * interrupted by an app restart replays with agents still marked
 * `progress` and a `startedAt` from whenever it happened. Interpolating
 * those against *now* would report an agent as having run for six days.
 * Off the live path we show nothing rather than a fabricated duration.
 */
function agentElapsedMs(
  agent: WorkflowAgentEntry,
  now: number,
  live: boolean,
): number | null {
  if (typeof agent.durationMs === "number") return agent.durationMs;
  if (!live || isAgentTerminal(agent)) return null;
  if (typeof agent.startedAt !== "number") return null;
  return Math.max(0, now - agent.startedAt);
}

/** Ticks once a second while `active`, so interpolated elapsed times
 *  advance. Returns a stable value when inactive so a finished card never
 *  re-renders on a timer. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function AgentRow({
  agent,
  now,
  live,
}: {
  agent: WorkflowAgentEntry;
  now: number;
  live: boolean;
}) {
  const elapsedMs = agentElapsedMs(agent, now, live);
  // Both fields are optional, so the persistence boundary guard didn't
  // type-check them — read through `readOptionalString` before `.trim()`.
  const lastToolName = readOptionalString(agent.lastToolName);
  const detail =
    readOptionalString(agent.lastToolSummary)?.trim() ||
    (lastToolName ? `${lastToolName}…` : "");

  return (
    <div className={styles.agent}>
      <span
        className={`${styles.stateIcon} ${stateClass(agent.state)}`}
        role="img"
        aria-label={agent.state || "queued"}
      >
        {stateIcon(agent.state)}
      </span>
      <span
        className={`${styles.agentLabel} ${
          isAgentTerminal(agent) ? styles.agentLabelDone : ""
        }`}
        title={agent.promptPreview ?? agent.label}
      >
        {agent.label || `agent ${agent.index}`}
      </span>
      <span className={styles.agentMeta}>
        {agent.cached && <span className={styles.cachedBadge}>cached</span>}
        {typeof agent.attempt === "number" && agent.attempt > 1 && (
          <span
            className={styles.attemptBadge}
            title={agent.lastAttemptReason ?? undefined}
          >
            retry {agent.attempt}
          </span>
        )}
        {agent.isolation && <span>{agent.isolation}</span>}
        {typeof agent.tokens === "number" && agent.tokens > 0 && (
          <span>{formatTokens(agent.tokens)}</span>
        )}
        {typeof agent.toolCalls === "number" && agent.toolCalls > 0 && (
          <span>
            {agent.toolCalls} tool{agent.toolCalls !== 1 ? "s" : ""}
          </span>
        )}
        {elapsedMs !== null && <span>{formatDurationMs(elapsedMs)}</span>}
      </span>
      {agent.error ? (
        <span className={styles.agentError} title={agent.error}>
          {agent.error}
        </span>
      ) : (
        detail && (
          <span className={styles.agentDetail} title={detail}>
            {detail}
          </span>
        )
      )}
    </div>
  );
}

/**
 * The workflow script, behind a collapsed disclosure.
 *
 * The `<pre>` is mounted only while open. A collapsed `<details>` doesn't
 * paint its contents, but the text nodes still exist — and a long-lived
 * session accumulates one card per run inside a transcript that already
 * holds every completed turn. Measured against real runs, scripts are a
 * median of ~10 KB and up to ~30 KB, so this is a modest saving per card
 * rather than a dramatic one; it's here because the cost is pure waste
 * (nobody reads most of these) and the fix is four lines.
 *
 * `onToggle` drives local state rather than the `open` attribute, so the
 * element stays uncontrolled and keeps the browser's native disclosure
 * behavior — including keyboard activation and find-in-page auto-expand.
 */
function ScriptDisclosure({
  script,
  lineCount,
}: {
  script: string;
  lineCount: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className={styles.script}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className={styles.scriptToggle}>
        Script ({lineCount} line{lineCount !== 1 ? "s" : ""})
      </summary>
      {open && <pre className={styles.scriptBody}>{script}</pre>}
    </details>
  );
}

/**
 * Renders a `Workflow` tool call as its live phase/agent tree.
 *
 * Before this existed, a workflow showed up as one tool row whose summary
 * was a truncated dump of the minified script, followed by several minutes
 * of nothing while the run happened out of view.
 *
 * The tree arrives on `system`/`task_progress` events (see
 * `useAgentStream`) and is persisted with the turn, so a completed run
 * renders identically after a reload.
 */
export function WorkflowCard({
  activity,
  collapsed,
  onToggle,
  inline = false,
  live = false,
}: {
  activity: ToolActivity;
  /** Omit (with `onToggle`) for the always-expanded inline display mode. */
  collapsed?: boolean;
  onToggle?: () => void;
  inline?: boolean;
  /** True when rendered from the in-flight turn's activities rather than
   *  replayed from a completed turn. Only a live card runs the clock. */
  live?: boolean;
}) {
  const name = useMemo(
    () => workflowDisplayName(activity.inputJson),
    [activity.inputJson],
  );
  const description = useMemo(
    () => workflowDescription(activity.inputJson),
    [activity.inputJson],
  );
  const isResume = useMemo(
    () => isWorkflowResume(activity.inputJson),
    [activity.inputJson],
  );
  const summary = useMemo(
    () => summarizeWorkflowProgress(activity.workflowProgress),
    [activity.workflowProgress],
  );
  const script = useMemo(
    () => workflowScript(activity.inputJson),
    [activity.inputJson],
  );
  const scriptLineCount = useMemo(
    () => (script ? script.split("\n").length : 0),
    [script],
  );

  // NOT `resultText.length > 0` — the idiom used for every other tool. A
  // workflow's tool_result lands within a second of launch ("Workflow
  // launched in background. Task ID: …"); the run itself takes minutes.
  // Completion arrives much later as a task-notification, which
  // `useAgentStream` maps onto `agentStatus`.
  const finished = isTerminalWorkflowStatus(activity.agentStatus);
  // `live` gates the interpolated clock. A run that was still going when
  // the app closed replays with non-terminal agents forever; without this
  // its elapsed times would tick upward on every reload, reporting minutes
  // of work that never happened.
  const isRunning = live && !finished;
  const now = useSecondTick(isRunning);

  const collapsible = !inline && typeof onToggle === "function";
  const isCollapsed = collapsible && collapsed === true;

  // Group agents under their phase. Sections are ordered by *declaration*
  // order (`summary.phases`), not by which phase's first agent happened to
  // arrive first — those diverge under a pipeline, where a later phase's
  // agent can start before an earlier phase's slow agent finishes, and
  // first-seen order would then reshuffle the sections mid-run. Any phase
  // that has agents but was never declared via `phase()` — including the
  // no-phase bucket for `agent()` calls made before any `phase()` — keeps
  // its first-seen position, appended after the declared phases.
  const grouped = useMemo(() => {
    const byPhase = new Map<string, WorkflowAgentEntry[]>();
    for (const agent of summary.agents) {
      const key = phaseTitleOf(agent) ?? UNPHASED;
      const bucket = byPhase.get(key);
      if (bucket) bucket.push(agent);
      else byPhase.set(key, [agent]);
    }

    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    for (const phase of summary.phases) {
      if (byPhase.has(phase.title) && !seen.has(phase.title)) {
        orderedKeys.push(phase.title);
        seen.add(phase.title);
      }
    }
    for (const key of byPhase.keys()) {
      if (!seen.has(key)) {
        orderedKeys.push(key);
        seen.add(key);
      }
    }

    return orderedKeys.map((title) => ({
      title: title === UNPHASED ? null : title,
      agents: byPhase.get(title)!,
    }));
  }, [summary.agents, summary.phases]);

  const headerInteractiveProps = collapsible
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-expanded": !isCollapsed,
        "aria-label": `${isCollapsed ? "Expand" : "Collapse"} workflow ${name}`,
        onClick: onToggle,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        },
      }
    : undefined;

  const progressPct =
    summary.totalCount > 0
      ? Math.round((summary.doneCount / summary.totalCount) * 100)
      : 0;

  return (
    // Anchor for the status pill's scroll-into-view — see `workflowAnchor`.
    <div className={styles.card} {...{ [WORKFLOW_CARD_ANCHOR_ATTR]: activity.toolUseId }}>
      <div className={styles.header} {...headerInteractiveProps}>
        {collapsible && (
          <span className={styles.chevron} aria-hidden="true">
            {isCollapsed ? "›" : "⌄"}
          </span>
        )}
        <span className={styles.toolName}>Workflow</span>
        <span className={styles.name} title={description ?? name}>
          {name}
        </span>
        <span className={styles.badge}>
          {isResume && <span className={styles.resumeBadge}>resumed</span>}
          {summary.errorCount > 0 && (
            <span className={styles.errorBadge}>
              {summary.errorCount} failed
            </span>
          )}
          {summary.totalCount > 0 && (
            <span>
              {summary.doneCount}/{summary.totalCount} agents
            </span>
          )}
          {summary.totalTokens > 0 && (
            <span>{formatTokens(summary.totalTokens)}</span>
          )}
        </span>
      </div>

      {summary.totalCount > 0 && (
        <div
          className={styles.rail}
          role="progressbar"
          aria-valuenow={summary.doneCount}
          aria-valuemin={0}
          aria-valuemax={summary.totalCount}
          aria-label={`Workflow ${name} progress`}
        >
          <div
            className={`${styles.railFill} ${
              summary.errorCount > 0
                ? styles.railFillError
                : finished
                  ? styles.railFillDone
                  : ""
            }`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {!isCollapsed && (
        <div className={styles.body}>
          {description && <div className={styles.description}>{description}</div>}
          {summary.totalCount === 0 ? (
            <div className={styles.empty}>
              {finished
                ? "No agent activity was reported for this run."
                : "Starting workflow…"}
            </div>
          ) : (
            grouped.map(({ title, agents }, i) => (
              <div className={styles.phase} key={title ?? `unphased-${i}`}>
                {title && <div className={styles.phaseTitle}>{title}</div>}
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.index}
                    agent={agent}
                    now={now}
                    live={isRunning}
                  />
                ))}
              </div>
            ))
          )}
          {script && (
            <ScriptDisclosure script={script} lineCount={scriptLineCount} />
          )}
        </div>
      )}
    </div>
  );
}
