import { useState } from "react";

export interface PlanInput {
  plan?: string;
}

interface Props {
  toolUseId: string;
  input: PlanInput;
  onSubmit: (approved: boolean, reason?: string) => Promise<void>;
  /**
   * Dismiss handler. The agent is mid-turn waiting for a control_response
   * to ExitPlanMode — the caller is responsible for sending some response
   * (typically `approved=false` with a "user dismissed" feedback string)
   * so the CLI doesn't block indefinitely. See ChatScreen.tsx for wiring.
   */
  onDismiss: () => Promise<void> | void;
}

// Inline card (not a sheet) that surfaces an `ExitPlanMode` tool call.
// The model presents a plan; the user either approves (agent continues
// to execute) or denies with optional feedback (agent revises and
// resubmits the plan).

export function PlanApprovalCard({ input, onSubmit, onDismiss }: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denying, setDenying] = useState(false);

  const handleApprove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeny = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(false, reason.trim() || undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plan-card">
      <div className="plan-header">
        <h3>Approve plan</h3>
        <button className="ghost-btn" onClick={() => void onDismiss()}>
          Dismiss
        </button>
      </div>
      <div className="plan-body">
        {input.plan ? (
          <pre className="plan-text">{input.plan}</pre>
        ) : (
          <p className="hint">No plan content received.</p>
        )}
      </div>
      {denying && (
        <input
          className="paste-input"
          placeholder="Optional feedback for the agent…"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      )}
      {error && <div className="error">{error}</div>}
      <div className="plan-actions">
        {!denying ? (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setDenying(true)}
            >
              Deny
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void handleApprove()}
            >
              {busy ? "Approving…" : "Approve"}
            </button>
          </>
        ) : (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setDenying(false)}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void handleDeny()}
            >
              {busy ? "Sending…" : "Send feedback"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
