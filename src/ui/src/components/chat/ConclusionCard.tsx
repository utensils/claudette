import { useTranslation } from "react-i18next";
import type { AgentConclusion } from "../../types";
import { MessageMarkdown } from "./MessageMarkdown";
import { useWorkspaceFileOpener } from "./useWorkspaceFileOpener";
import styles from "./ConclusionCard.module.css";

interface ConclusionCardProps {
  conclusion: AgentConclusion;
  /** Owning workspace, so file-path links in the summary (and the artifact
   *  list) route into this workspace's Monaco tab — same as PlanApprovalCard. */
  workspaceId: string;
}

/**
 * Renders a finished-work conclusion the agent presented via
 * `mcp__claudette__present_conclusion`. Takes its visual cues from
 * `PlanApprovalCard` but is purely presentational: the markdown body is
 * expanded by default (no click-to-reveal) and there are no permissions or
 * approve/deny actions.
 */
export function ConclusionCard({ conclusion, workspaceId }: ConclusionCardProps) {
  const { t } = useTranslation("chat");
  const { openFile, resolveFilePath } = useWorkspaceFileOpener(workspaceId);
  const title = conclusion.title?.trim();
  const artifacts = conclusion.artifacts.filter((p) => p.trim() !== "");

  return (
    <div className={styles.card}>
      <div className={styles.label}>{t("conclusion_label")}</div>
      {title && <div className={styles.title}>{title}</div>}
      <div className={styles.content}>
        <MessageMarkdown
          content={conclusion.summary}
          onOpenFile={openFile}
          resolveFilePath={resolveFilePath}
        />
      </div>
      {artifacts.length > 0 && (
        <div className={styles.artifacts}>
          <div className={styles.artifactsLabel}>
            {t("conclusion_artifacts")}
          </div>
          <ul className={styles.artifactsList}>
            {artifacts.map((path, i) => (
              <li key={`${path}-${i}`} className={styles.artifactItem}>
                <button
                  type="button"
                  className={styles.artifactLink}
                  onClick={() => {
                    openFile(path);
                  }}
                  title={path}
                >
                  {path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
