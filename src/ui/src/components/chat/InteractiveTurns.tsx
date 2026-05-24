// Embedded (in-chat) view of an interactive Claude session.
//
// G6's default render path for workspaces whose effective harness is
// `claude_interactive`. We feed the live event streams through the
// hook-delimited turn assembler (G4) and render one `InteractiveTurnView`
// (G5) per assembled `Turn` so the chat scroll history matches the way
// users already read traditional Claude Code sessions: each
// prompt → response pair gets its own bordered card, oldest at the top,
// newest at the bottom.
//
// Two small affordances also live here so ChatPanel's diff stays
// minimal (it's the god file from the CLAUDE.md list):
//   - `AwaitingPill` — non-blocking status hint when Claude is waiting
//     on a user-facing question (`AskUserQuestion` / `ExitPlanMode`).
//   - `CrashedBanner` — sticky error when the underlying tmux/sidecar
//     session exited unexpectedly. Bare-bones for v1; G9 / G10 will
//     replace it with a richer recovery affordance.

import { useInteractiveTurnAssembler } from "../../hooks/useInteractiveTurnAssembler";
import type { Turn } from "../../hooks/useInteractiveTurnAssembler";
import { InteractiveTurnView } from "./InteractiveTurnView";
import styles from "./InteractiveTurns.module.css";

interface InteractiveTurnsProps {
  sid: string;
}

/** Map a `Turn.status` to the per-turn wrapper class. Kept explicit so a
 *  future status (e.g. `"compacted"`) lands as a compile error rather
 *  than a silent fallthrough to the default styling. */
function statusClass(status: Turn["status"]): string {
  switch (status) {
    case "live":
      return styles.turnLive;
    case "done":
      return styles.turnDone;
    case "crashed":
      return styles.turnCrashed;
  }
}

function AwaitingPill() {
  return (
    <div
      className={styles.awaitingPill}
      role="status"
      aria-live="polite"
      data-testid="interactive-awaiting-pill"
    >
      Waiting on your input…
    </div>
  );
}

function CrashedBanner() {
  return (
    <div
      className={styles.crashedBanner}
      role="alert"
      data-testid="interactive-crashed-banner"
    >
      Interactive session ended unexpectedly.
    </div>
  );
}

export function InteractiveTurns({ sid }: InteractiveTurnsProps) {
  const { turns, awaitingInput, crashed } = useInteractiveTurnAssembler(sid);

  return (
    <div className={styles.turns} data-testid="interactive-turns">
      {turns.map((turn) => (
        <div key={turn.id} className={`${styles.turn} ${statusClass(turn.status)}`}>
          <InteractiveTurnView bytes={turn.bytes} />
        </div>
      ))}
      {awaitingInput && <AwaitingPill />}
      {crashed && <CrashedBanner />}
    </div>
  );
}
