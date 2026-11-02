import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceElapsedSeconds } from "../../hooks/useWorkspaceElapsedSeconds";
import { formatElapsedSeconds } from "./chatHelpers";
import styles from "./ChatPanel.module.css";

/**
 * "Agent is working" spinner + elapsed time under the transcript.
 *
 * Owns the 1 Hz elapsed-seconds timer itself. It used to live in
 * `ChatPanel`, where each tick re-rendered the whole panel — and, through
 * it, the entire transcript — once a second for the length of every turn.
 */
export function ProcessingIndicator({
  workspaceId,
  isRunning,
  isCompacting,
  processingRef,
}: {
  workspaceId: string | null;
  isRunning: boolean;
  isCompacting: boolean;
  processingRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation("chat");
  const elapsed = formatElapsedSeconds(
    useWorkspaceElapsedSeconds(workspaceId, isRunning),
  );
  return (
    <div
      ref={processingRef}
      className={styles.processing}
      role="status"
      aria-label={
        isCompacting
          ? t("compacting_aria", { elapsed })
          : t("processing_aria", { elapsed })
      }
    >
      <span className={styles.spinnerWrap} aria-hidden="true">
        <span className={styles.spinner} />
      </span>
      {isCompacting && (
        <span className={styles.compactingLabel}>{t("compacting_label")}</span>
      )}
      <span className={styles.elapsed}>{elapsed}</span>
    </div>
  );
}
