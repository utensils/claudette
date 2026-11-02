import styles from "./TaskStateIcon.module.css";

/** Normalized lifecycle state shared by workflow agents and subagents. */
export type TaskState = "queued" | "progress" | "done" | "error" | "stopped";

export function taskStateGlyph(state: string): string {
  switch (state) {
    case "done":
      return "●";
    case "error":
      return "✕";
    case "progress":
      return "◐";
    case "stopped":
      // Reconciled straggler: the run ended before this agent did. Distinct
      // from "queued" so a cancelled run doesn't read as one that never
      // started, and from "error" so it doesn't read as a failure.
      return "–";
    default:
      // Covers "queued" and any state we don't recognize — both mean
      // "hasn't produced anything yet" as far as the reader is concerned.
      return "○";
  }
}

function stateClass(state: string): string {
  switch (state) {
    case "done":
      return styles.done;
    case "error":
      return styles.error;
    case "progress":
      return styles.progress;
    // "stopped" shares the muted treatment with "queued": neither produced
    // a result, and neither is a failure worth colouring.
    default:
      return styles.queued;
  }
}

/** Colored state glyph (● ✕ ◐ – ○) used by workflow agent rows and Agent
 *  tool headers so both read the same at a glance. */
export function TaskStateIcon({
  state,
  label,
  className,
}: {
  state: string;
  /** Accessible name; defaults to the state itself. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`${styles.icon} ${stateClass(state)}${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label ?? (state || "queued")}
    >
      {taskStateGlyph(state)}
    </span>
  );
}
