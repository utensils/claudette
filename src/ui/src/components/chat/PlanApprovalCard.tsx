import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageMarkdown } from "./MessageMarkdown";
import type { PlanApproval } from "../../stores/useAppStore";
import { useAppStore } from "../../stores/useAppStore";
import { useSelfParticipantId } from "../../hooks/useSelfParticipantId";
import { readPlanFile, sendRemoteCommand } from "../../services/tauri";
import { CopyButton } from "../shared/CopyButton";
import styles from "./PlanApprovalCard.module.css";

interface PlanApprovalCardProps {
  approval: PlanApproval;
  /**
   * Called with the user's decision. `approved=true` lets the CLI run the
   * ExitPlanMode tool's `call()` (which writes the plan file and emits the
   * real tool_result). `approved=false` sends a deny with the given reason.
   */
  onRespond: (approved: boolean, reason?: string) => void | Promise<void>;
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
  const [submitting, setSubmitting] = useState(false);
  // Memoize an in-flight read so concurrent callers (e.g. user clicks
  // Copy and View Plan in quick succession) share a single network call
  // instead of issuing duplicate `readPlanFile` / `sendRemoteCommand`
  // requests. Cleared in a `finally` so a failed fetch can be retried.
  const inFlightFetchRef = useRef<Promise<string> | null>(null);
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchPlanContent = (): Promise<string> => {
    if (planContent !== null) return Promise.resolve(planContent);
    if (inFlightFetchRef.current) return inFlightFetchRef.current;
    if (!approval.planFilePath) {
      return Promise.reject(new Error("No plan file path"));
    }
    const planFilePath = approval.planFilePath;
    const promise = (async () => {
      const content = remoteConnectionId
        ? ((await sendRemoteCommand(remoteConnectionId, "read_plan_file", {
            chat_session_id: approval.sessionId,
            path: planFilePath,
          })) as string)
        : await readPlanFile(planFilePath);
      setPlanContent(content);
      return content;
    })().finally(() => {
      inFlightFetchRef.current = null;
    });
    inFlightFetchRef.current = promise;
    return promise;
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

  const submitResponse = async (approved: boolean, reason?: string) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onRespond(approved, reason);
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      }
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
          <CopyButton
            variant="bare"
            className={styles.copyBtn}
            source={fetchPlanContent}
            tooltip={{
              copy: t("plan_approval_copy"),
              copied: t("plan_approval_copied"),
            }}
            disabled={loading}
            onError={(e) => {
              console.error("Failed to copy plan:", e);
              setLoadError(t("plan_approval_failed_read"));
            }}
          />
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

      <ConsensusProgress approval={approval} />

      <button
        className={styles.approveBtn}
        onClick={() => {
          void submitResponse(true);
        }}
        disabled={submitting}
      >
        {t("plan_approval_approve")}
      </button>

      <div className={styles.divider}>{t("plan_approval_or_feedback")}</div>

      <div className={styles.freeformRow}>
        <textarea
          className={styles.freeformInput}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          disabled={submitting}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const text = feedback.trim();
              if (text) void submitResponse(false, text);
            }
          }}
          placeholder={t("plan_approval_feedback_placeholder")}
          rows={1}
        />
        <button
          className={styles.feedbackBtn}
          onClick={() => {
            const text = feedback.trim();
            if (text) void submitResponse(false, text);
          }}
          disabled={submitting || !feedback.trim()}
        >
          {t("plan_approval_send")}
        </button>
      </div>
    </div>
  );
}


/**
 * Render the per-voter vote state for an open consensus round. No-op when
 * the session has no open vote (solo or non-consensus collab) — the card
 * then behaves identically to its pre-collab single-shot form.
 *
 * The local marker is derived from the current workspace's self participant id,
 * not from the host sentinel, so remote viewers see their own vote labeled.
 */
function ConsensusProgress({ approval }: { approval: PlanApproval }) {
  const { t } = useTranslation("chat");
  const vote = useAppStore((s) => s.consensusVotes[approval.sessionId]);
  // Compare voter ids against the local participant's id (the workspace's
  // self-pid), NOT the literal `"host"` — on a remote client the local
  // user's pid is the remote-issued string, so hardcoding `"host"` would
  // mark the host as "you" for every remote viewer of the same plan card.
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selfParticipantId = useSelfParticipantId(selectedWorkspaceId);
  if (!vote || vote.toolUseId !== approval.toolUseId) {
    return null;
  }
  const totalRequired = vote.requiredVoters.length;
  const totalVoted = Object.keys(vote.votes).length;
  return (
    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      <div>
        <strong>
          {t("plan_approval_consensus_required", {
            voted: totalVoted,
            required: totalRequired,
          })}
        </strong>
      </div>
      {vote.requiredVoters.map((voter) => {
        const cast = vote.votes[voter.id];
        const status = cast
          ? cast.kind === "approve"
            ? t("plan_approval_vote_approved")
            : t("plan_approval_vote_denied", { reason: cast.reason })
          : t("plan_approval_vote_waiting");
        const isSelf = voter.id === selfParticipantId;
        return (
          <div key={voter.id}>
            <span>{voter.display_name}</span>
            {isSelf ? ` ${t("plan_approval_you_marker")}` : ""}
            {voter.is_host ? ` · ${t("plan_approval_host_marker")}` : ""}
            {": "}
            <em>{status}</em>
          </div>
        );
      })}
    </div>
  );
}
