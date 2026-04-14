import { useState } from "react";
import Markdown from "react-markdown";
import { preprocessContent, REHYPE_PLUGINS, REMARK_PLUGINS } from "../../utils/markdown";
import type { PlanApproval } from "../../stores/useAppStore";
import { readPlanFile, sendRemoteCommand } from "../../services/tauri";
import styles from "./PlanApprovalCard.module.css";

interface PlanApprovalCardProps {
  approval: PlanApproval;
  onRespond: (response: string) => void;
  remoteConnectionId?: string;
}

export function PlanApprovalCard({
  approval,
  onRespond,
  remoteConnectionId,
}: PlanApprovalCardProps) {
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

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
      setPlanContent("(Failed to read plan file)");
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.label}>Plan Ready for Approval</div>

      <div className={styles.description}>
        The agent has written a plan and is requesting approval to proceed with
        implementation.
      </div>

      {approval.planFilePath && (
        <button
          className={styles.planLink}
          onClick={handleViewPlan}
          disabled={loading}
        >
          {loading ? "Loading..." : expanded ? "Hide plan" : "View plan"}
          {" \u2014 "}
          {approval.planFilePath.split("/").slice(-2).join("/")}
        </button>
      )}

      {expanded && planContent && (
        <div className={styles.planContent}>
          <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
            {preprocessContent(planContent)}
          </Markdown>
        </div>
      )}

      {approval.allowedPrompts.length > 0 && (
        <div className={styles.permissions}>
          <div className={styles.permLabel}>Requested permissions</div>
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

      <div className={styles.actions}>
        <button
          className={styles.approveBtn}
          onClick={() => onRespond("Plan approved. Proceed with implementation.")}
        >
          Approve plan
        </button>
        <button
          className={styles.denyBtn}
          onClick={() => onRespond("Plan denied. Please revise the approach.")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
