import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentApproval } from "../../stores/useAppStore";
import styles from "./PlanApprovalCard.module.css";

interface AgentApprovalCardProps {
  approval: AgentApproval;
  onRespond: (approved: boolean, reason?: string) => void;
}

export function AgentApprovalCard({ approval, onRespond }: AgentApprovalCardProps) {
  const { t } = useTranslation("chat");
  const [feedback, setFeedback] = useState("");
  const deny = () => {
    const reason = feedback.trim();
    onRespond(false, reason || undefined);
  };

  return (
    <div className={styles.card}>
      <div className={styles.label}>{t("agent_approval_label")}</div>

      <div className={styles.description}>
        <strong>{approval.title}</strong>
        <br />
        {approval.description}
      </div>

      {approval.details.length > 0 && (
        <div className={styles.permissions}>
          <div className={styles.permLabel}>{t("agent_approval_details")}</div>
          <div className={styles.permList}>
            {approval.details.map((detail) => (
              <div key={detail.label} className={styles.permItem}>
                <span className={styles.permTool}>{detail.label}</span>
                <span>{detail.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button className={styles.approveBtn} onClick={() => onRespond(true)}>
        {t("agent_approval_approve")}
      </button>

      <div className={styles.divider}>{t("agent_approval_or_deny")}</div>

      <div className={styles.freeformRow}>
        <textarea
          className={styles.freeformInput}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              deny();
            }
          }}
          placeholder={t("agent_approval_feedback_placeholder")}
          rows={1}
        />
        <button className={styles.feedbackBtn} onClick={deny}>
          {t("agent_approval_deny")}
        </button>
      </div>
    </div>
  );
}
