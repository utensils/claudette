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

  return (
    <button
      type="button"
      className={styles.pill}
      onClick={onClick}
      aria-label={`Workflow ${name}, ${counts} agents complete. Jump to details.`}
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
