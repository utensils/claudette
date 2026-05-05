import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const fetchPlanContent = async (): Promise<string> => {
    if (planContent !== null) return planContent;
    if (!approval.planFilePath) throw new Error("No plan file path");
    let content: string;
    if (remoteConnectionId) {
      content = (await sendRemoteCommand(remoteConnectionId, "read_plan_file", {
        path: approval.planFilePath,
      })) as string;
    } else {
      content = await readPlanFile(approval.planFilePath);
    }
    setPlanContent(content);
    return content;
  };

  const handleViewPlan = async () => {
    if (planContent !== null) {
      setExpanded(!expanded);
      return;
    }
    if (!approval.planFilePath) return;
    setLoadError(null);
    setLoading(true);
    try {
      await fetchPlanContent();
      setExpanded(true);
    } catch (e) {
      console.error("Failed to read plan file:", e);
      setLoadError(t("plan_approval_failed_read"));
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyPlan = async () => {
    if (!approval.planFilePath) return;
    setLoadError(null);
    setCopying(true);
    try {
      const content = await fetchPlanContent();
      await clipboardWriteText(content);
      setCopied(true);
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      console.error("Failed to copy plan:", e);
      setLoadError(t("plan_approval_failed_read"));
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.label}>{t("plan_approval_label")}</div>

      <div className={styles.description}>
        {t("plan_approval_description")}
      </div>

      {approval.planFilePath && (
        <div className={styles.planActions}>
          <button
            className={styles.planLink}
            onClick={handleViewPlan}
            disabled={loading || copying}
          >
            {loading
              ? t("plan_approval_loading")
              : expanded
                ? t("plan_approval_hide_plan")
                : t("plan_approval_view_plan")}
            {" \u2014 "}
            {approval.planFilePath.split("/").slice(-2).join("/")}
          </button>
          <button
            type="button"
            className={styles.copyBtn}
            onClick={handleCopyPlan}
            disabled={loading || copying}
            title={copied ? t("plan_approval_copied") : t("plan_approval_copy")}
            aria-label={copied ? t("plan_approval_copied") : t("plan_approval_copy")}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            )}
          </button>
        </div>
      )}

      {expanded && planContent && (
        <div className={styles.planContent}>
          <MessageMarkdown content={planContent} />
        </div>
      )}

      {expanded && !planContent && loadError && (
        <div className={styles.planContent}>{loadError}</div>
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
