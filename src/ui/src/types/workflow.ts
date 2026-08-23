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

/**
 * Boundary check for a single entry decoded from persisted JSON.
 *
 * Validates the kind *and* the fields that kind declares as required, so
 * the type predicate is honest about everything the interface says is
 * non-optional. `Unknown` is an accepted kind on purpose: Rust maps any
 * incoming kind it doesn't recognize to it, making it a legitimate stored
 * value rather than a parse failure.
 *
 * **Optional fields are not type-checked here.** Doing so would mean
 * per-field validation of ~25 attributes to guard against data we
 * ourselves serialized from Rust, where the types are already enforced.
 * The cost of that trade is real but bounded: a corrupt optional field
 * survives this check, so accessors that call *methods* on one must
 * tolerate a wrong type. `readOptionalString` exists for exactly that and
 * is used at every such site — see `phaseTitleOf`. Numeric accumulators
 * take the same care via `readOptionalNumber`, where a stray string would
 * otherwise turn `+=` into concatenation and silently corrupt a total
 * rather than throwing.
 */
export function isWorkflowProgressEntry(
  value: unknown,
): value is WorkflowProgressEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  switch (entry.type) {
    case "workflow_phase":
      return typeof entry.index === "number" && typeof entry.title === "string";
    case "workflow_agent":
      return (
        typeof entry.index === "number" &&
        typeof entry.label === "string" &&
        typeof entry.state === "string"
      );
    case "Unknown":
      return true;
    default:
      return false;
  }
}

/** Read an optional string field that survived `isWorkflowProgressEntry`
 *  without being type-checked. Returns null for anything that isn't a
 *  string, so a corrupt value degrades to "absent" instead of throwing
 *  when a caller reaches for a string method. */
export function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Numeric counterpart to `readOptionalString`. Rejects NaN and infinities
 *  as well as non-numbers, so a corrupt value contributes 0 to a running
 *  total rather than poisoning it into NaN. */
export function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
 *  silently reporting a run as finished.
 *
 *  `"done"` and `"error"` are the CLI's own values. `"stopped"` is ours:
 *  when a run reports a terminal status while its last progress snapshot
 *  still showed agents in flight, Rust stamps the stragglers so the tree
 *  can't keep advertising an unfinished fraction for a finished run — see
 *  `reconcile_tree_on_terminal` in `src/agent/workflow_progress.rs`. It is
 *  used only when the run did *not* complete, so it stays out of
 *  `errorCount` and never inflates the failure badge. */
const TERMINAL_AGENT_STATES = new Set(["done", "error", "stopped"]);

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
  // Read through `readOptionalString` rather than trusting the declared
  // type: `phaseTitle` is optional, so the boundary guard didn't verify it,
  // and `.trim()` on a non-string throws.
  const title = readOptionalString(agent.phaseTitle)?.trim();
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
    // `?? 0` alone would let a corrupt non-number through `+=`, turning the
    // total into a concatenated string or NaN rather than failing loudly.
    totalTokens += readOptionalNumber(agent.tokens) ?? 0;
    totalToolCalls += readOptionalNumber(agent.toolCalls) ?? 0;
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
