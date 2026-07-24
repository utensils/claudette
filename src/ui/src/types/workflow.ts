/** The phase/agent tree Claude Code's `Workflow` tool reports on
 *  `subtype: "task_progress"` stream events.
 *
 *  Mirrors `WorkflowProgressEntry` / `WorkflowAgentProgress` in
 *  `src/agent/types.rs`. Field names are camelCase because that is what the
 *  CLI emits inside these entries — the enclosing `system` event is
 *  snake_case, and Rust re-serializes the inner struct with
 *  `rename_all = "camelCase"` to preserve that.
 *
 *  Optional fields are typed `| null` (not just `?`) because Rust's
 *  `Option<T>` serializes as an explicit `null` here — only the top-level
 *  `workflow_progress` array itself carries `skip_serializing_if`.
 */
export interface WorkflowPhaseEntry {
  type: "workflow_phase";
  index: number;
  title: string;
}

export interface WorkflowAgentEntry {
  type: "workflow_agent";
  /** Position in the run's global agent ordering. Stable across
   *  re-emissions, so it is safe to use as a React key. */
  index: number;
  label: string;
  phaseIndex?: number | null;
  phaseTitle?: string | null;
  agentId?: string | null;
  agentType?: string | null;
  /** `"worktree"` or `"remote"` when the agent runs isolated. */
  isolation?: string | null;
  remoteSessionId?: string | null;
  model?: string | null;
  fallbackModel?: string | null;
  /** Observed: `"queued"`, `"progress"`, `"done"`, `"error"`. Deliberately
   *  a bare `string` — the Rust side keeps it unconstrained so a new
   *  upstream state can't break parsing, and the UI must not assume the
   *  set is closed either. */
  state: string;
  startedAt?: number | null;
  queuedAt?: number | null;
  lastProgressAt?: number | null;
  /** Retry counter, 1-based. `> 1` means an earlier attempt failed. */
  attempt?: number | null;
  lastAttemptReason?: string | null;
  lastToolName?: string | null;
  lastToolSummary?: string | null;
  promptPreview?: string | null;
  resultPreview?: string | null;
  tokens?: number | null;
  toolCalls?: number | null;
  durationMs?: number | null;
  /** `true` when a resumed run served this agent from cache rather than
   *  re-running it. */
  cached?: boolean | null;
  error?: string | null;
}

/** Entry kinds we don't model. Rust maps any unrecognized `type` here so a
 *  future upstream addition can't cost us the rest of the tree. */
export interface WorkflowUnknownEntry {
  type: "Unknown";
}

export type WorkflowProgressEntry =
  | WorkflowPhaseEntry
  | WorkflowAgentEntry
  | WorkflowUnknownEntry;

/** The complete set of entry kinds Rust can persist. `Unknown` is included
 *  deliberately: the Rust side maps any unrecognized incoming kind to it, so
 *  it is a legitimate stored value rather than a parse failure. */
const KNOWN_ENTRY_TYPES = new Set<string>([
  "workflow_phase",
  "workflow_agent",
  "Unknown",
]);

/**
 * Boundary check for a single entry decoded from persisted JSON.
 *
 * Narrow enough to justify the type predicate: it accepts only the kinds
 * the union actually models. A looser "has a string `type`" check would
 * assert `WorkflowProgressEntry` for `{type: "bogus"}`, which is unsound —
 * harmless while every consumer re-discriminates on `type`, but a trap for
 * the first one that trusts the type instead (an exhaustive switch with a
 * `never` default, say, or reading `.label` off a presumed agent).
 */
export function isWorkflowProgressEntry(
  value: unknown,
): value is WorkflowProgressEntry {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && KNOWN_ENTRY_TYPES.has(type);
}

export function isWorkflowPhase(
  entry: WorkflowProgressEntry,
): entry is WorkflowPhaseEntry {
  return entry.type === "workflow_phase";
}

export function isWorkflowAgent(
  entry: WorkflowProgressEntry,
): entry is WorkflowAgentEntry {
  return entry.type === "workflow_agent";
}

/** Terminal states — an agent in one of these will not change again.
 *  Anything else (including a state we've never seen) counts as in-flight,
 *  so an unrecognized value degrades to "still running" rather than
 *  silently reporting a run as finished. */
const TERMINAL_AGENT_STATES = new Set(["done", "error"]);

export function isAgentTerminal(agent: WorkflowAgentEntry): boolean {
  return TERMINAL_AGENT_STATES.has(agent.state);
}

/**
 * An agent's phase title, or `null` when it has none.
 *
 * Normalizes the three ways "no phase" can arrive — `undefined`, an explicit
 * `null` (Rust's `Option<String>` serializes that way), and an empty or
 * whitespace-only string. Without the last case an agent could land in its
 * own phase group keyed on `""`, rendering as a nameless section separate
 * from the real unphased bucket.
 *
 * Shared by the summarizer and the card's grouping so both agree on which
 * agents count as unphased.
 */
export function phaseTitleOf(agent: WorkflowAgentEntry): string | null {
  const title = agent.phaseTitle?.trim();
  return title ? title : null;
}

export interface WorkflowRunSummary {
  phases: WorkflowPhaseEntry[];
  agents: WorkflowAgentEntry[];
  /** Agents in a terminal state. */
  doneCount: number;
  /** Agents that ended in `error`. */
  errorCount: number;
  totalCount: number;
  /** True while any agent is still queued or in flight. */
  running: boolean;
  totalTokens: number;
  totalToolCalls: number;
  /** Phase of the first in-flight agent that declares one; when nothing is
   *  in flight, the last declared phase. `null` when agents are running but
   *  none is phased — better to say nothing than to name a phase no agent
   *  is actually working in. Drives the pill's "· Verify" segment. */
  currentPhaseTitle: string | null;
}

/**
 * Collapse a raw progress array into render-ready totals.
 *
 * Two things this has to get right:
 *
 * 1. **De-duplication.** The CLI re-emits a full `workflow_agent` entry on
 *    every state transition, so the same `index` appears repeatedly within
 *    one snapshot. Last-write-wins per index, which matches the upstream
 *    semantics ("the latest entry supersedes earlier ones") and keeps
 *    counts from inflating past `totalCount`.
 * 2. **Order.** Agents come back in first-seen order, not index order, so
 *    a phase-2 agent that started before a slow phase-1 agent finished
 *    doesn't jump the list on a later tick.
 */
export function summarizeWorkflowProgress(
  entries: WorkflowProgressEntry[] | undefined,
): WorkflowRunSummary {
  const phases: WorkflowPhaseEntry[] = [];
  const agentsByIndex = new Map<number, WorkflowAgentEntry>();
  const order: number[] = [];

  for (const entry of entries ?? []) {
    if (isWorkflowPhase(entry)) {
      phases.push(entry);
    } else if (isWorkflowAgent(entry)) {
      if (!agentsByIndex.has(entry.index)) order.push(entry.index);
      agentsByIndex.set(entry.index, entry);
    }
  }

  const agents = order.map((index) => agentsByIndex.get(index)!);

  let doneCount = 0;
  let errorCount = 0;
  let totalTokens = 0;
  let totalToolCalls = 0;
  let hasInFlight = false;
  let currentPhaseTitle: string | null = null;

  for (const agent of agents) {
    if (isAgentTerminal(agent)) {
      doneCount++;
    } else {
      hasInFlight = true;
      // First in-flight agent that actually declares a phase wins. An
      // unphased one contributes nothing here but still counts as in
      // flight, which is what stops the fallback below from firing.
      if (currentPhaseTitle === null) currentPhaseTitle = phaseTitleOf(agent);
    }
    if (agent.state === "error") errorCount++;
    totalTokens += agent.tokens ?? 0;
    totalToolCalls += agent.toolCalls ?? 0;
  }

  // Fall back to the last declared phase only when nothing is in flight —
  // the run finished, or the first tick arrived before any agent did.
  //
  // The `!hasInFlight` guard is the point: with agents running but none
  // carrying a phase (a script that calls `agent()` before any `phase()`),
  // an ungated fallback would name the last declared phase and the pill
  // would confidently report a phase nothing is actually working in.
  if (currentPhaseTitle === null && !hasInFlight && phases.length > 0) {
    currentPhaseTitle = phases[phases.length - 1].title;
  }

  return {
    phases,
    agents,
    doneCount,
    errorCount,
    totalCount: agents.length,
    // Same quantity as `hasInFlight` by construction (every agent is either
    // terminal or in flight); sharing the one source keeps them from
    // drifting if either definition is ever adjusted.
    running: hasInFlight,
    totalTokens,
    totalToolCalls,
    currentPhaseTitle,
  };
}
