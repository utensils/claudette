import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageMarkdown } from "./MessageMarkdown";
import type { PlanApproval } from "../../stores/useAppStore";
import { readPlanFile, sendRemoteCommand } from "../../services/tauri";
import styles from "./PlanApprovalCard.module.css";

interface PlanApprovalCardProps {
  approval: PlanApproval;
  /**
   * Called with the user's decision. `approved=true` lets the CLI run the
   * ExitPlanMode tool's `call()` (which writes the plan file and emits the
   * real tool_result). `approved=false` sends a deny with the given reason.
   */
  onRespond: (approved: boolean, reason?: string) => void;
  remoteConnectionId?: string;
}

export function PlanApprovalCard({
  approval,
  onRespond,
  remoteConnectionId,
}: PlanApprovalCardProps) {
  const { t } = useTranslation("chat");
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState("");

  const handleViewPlan = async () => {
    if (planContent !== null) {
      setExpanded(!expanded);
      return;
    }
    if (!approval.planFilePath) return;
    setLoading(true);
    try {
      let content: string;
      if (remoteConnectionId) {
        content = (await sendRemoteCommand(remoteConnectionId, "read_plan_file", {
          path: approval.planFilePath,
        })) as string;
      } else {
        content = await readPlanFile(approval.planFilePath);
      }
      setPlanContent(content);
      setExpanded(true);
    } catch (e) {
      console.error("Failed to read plan file:", e);
      setPlanContent(t("plan_approval_failed_read"));
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.label}>{t("plan_approval_label")}</div>

      <div className={styles.description}>
        {t("plan_approval_description")}
      </div>

      {approval.planFilePath && (
        <button
          className={styles.planLink}
          onClick={handleViewPlan}
          disabled={loading}
        >
          {loading
            ? t("plan_approval_loading")
            : expanded
              ? t("plan_approval_hide_plan")
              : t("plan_approval_view_plan")}
          {" \u2014 "}
          {approval.planFilePath.split("/").slice(-2).join("/")}
        </button>
      )}

      {expanded && planContent && (
        <div className={styles.planContent}>
          <MessageMarkdown content={planContent} />
        </div>
      )}

      {approval.allowedPrompts.length > 0 && (
        <div className={styles.permissions}>
          <div className={styles.permLabel}>{t("plan_approval_requested_permissions")}</div>
          <div className={styles.permList}>
            {approval.allowedPrompts.map((p, i) => (
              <div key={i} className={styles.permItem}>
                <span className={styles.permTool}>{p.tool}</span>
                <span>{p.prompt}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        className={styles.approveBtn}
        onClick={() => onRespond(true)}
      >
        {t("plan_approval_approve")}
      </button>

      <div className={styles.divider}>{t("plan_approval_or_feedback")}</div>

      <div className={styles.freeformRow}>
        <textarea
          className={styles.freeformInput}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const text = feedback.trim();
              if (text) onRespond(false, text);
            }
          }}
          placeholder={t("plan_approval_feedback_placeholder")}
          rows={1}
        />
        <button
          className={styles.feedbackBtn}
          onClick={() => {
            const text = feedback.trim();
            if (text) onRespond(false, text);
          }}
          disabled={!feedback.trim()}
        >
          {t("plan_approval_send")}
        </button>
      </div>
    </div>
  );
}
