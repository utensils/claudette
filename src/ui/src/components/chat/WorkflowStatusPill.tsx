import { memo, useCallback } from "react";
import { Workflow as WorkflowIcon } from "lucide-react";
import { useLiveWorkflows, type LiveWorkflow } from "../../hooks/useLiveWorkflows";
import { WORKFLOW_CARD_ANCHOR_ATTR } from "./workflowAnchor";
import styles from "./WorkflowStatusPill.module.css";

/**
 * Live status for backgrounded `Workflow` runs, pinned above the composer.
 *
 * The card in the transcript is the real surface; this exists because a
 * workflow runs for minutes while the user keeps working, and the card
 * scrolls out of reach almost immediately — a workflow's launching turn
 * usually ends seconds after it starts, so the card ends up buried under
 * whatever happened next. Clicking a pill scrolls its card back into view.
 */
function scrollToCard(toolUseId: string) {
  const target = document.querySelector(
    `[${WORKFLOW_CARD_ANCHOR_ATTR}="${CSS.escape(toolUseId)}"]`,
  );
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function WorkflowPill({ workflow }: { workflow: LiveWorkflow }) {
  const { summary, name, toolUseId } = workflow;
  const onClick = useCallback(() => scrollToCard(toolUseId), [toolUseId]);

  const counts =
    summary.totalCount > 0
      ? `${summary.doneCount}/${summary.totalCount}`
      : "starting";

  // Built independently of `counts`, which is shorthand tuned for the
  // pill's width ("1/3", "starting"). Reusing it here produced
  // "…, starting agents complete", and read "1/3" as a fraction. Errors
  // are folded in because `aria-label` *replaces* the button's accessible
  // name — the visual failure badge is not announced at all otherwise.
  const spokenProgress =
    summary.totalCount > 0
      ? `${summary.doneCount} of ${summary.totalCount} agents complete`
      : "starting";
  const spokenErrors =
    summary.errorCount > 0
      ? `, ${summary.errorCount} failed`
      : "";
  const ariaLabel = `Workflow ${name}, ${spokenProgress}${spokenErrors}. Jump to details.`;

  return (
    <button
      type="button"
      className={styles.pill}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <span className={styles.icon}>
        <WorkflowIcon
          size={13}
          aria-hidden="true"
          className={summary.running ? styles.spinning : undefined}
        />
      </span>
      <span className={styles.name}>{name}</span>
      {summary.currentPhaseTitle && (
        <>
          <span className={styles.separator} aria-hidden="true">
            ·
          </span>
          <span>{summary.currentPhaseTitle}</span>
        </>
      )}
      <span className={styles.separator} aria-hidden="true">
        ·
      </span>
      <span className={styles.counts}>{counts}</span>
      {summary.errorCount > 0 && (
        <span className={styles.errors}>{summary.errorCount} failed</span>
      )}
    </button>
  );
}

export const WorkflowStatusPill = memo(function WorkflowStatusPill({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const workflows = useLiveWorkflows(sessionId);
  if (workflows.length === 0) return null;

  return (
    <div className={styles.stack} aria-live="polite">
      {workflows.map((workflow) => (
        <WorkflowPill key={workflow.toolUseId} workflow={workflow} />
      ))}
    </div>
  );
});
