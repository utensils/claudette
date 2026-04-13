import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { runWorkspaceSetup } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function ConfirmSetupScriptModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const openModal = useAppStore((s) => s.openModal);
  const modalData = useAppStore((s) => s.modalData);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const [loading, setLoading] = useState(false);

  const workspaceId = modalData.workspaceId as string;
  const script = modalData.script as string;
  const source = modalData.source as string;
  const repoId = modalData.repoId as string | undefined;

  const handleRun = async () => {
    setLoading(true);
    try {
      const sr = await runWorkspaceSetup(workspaceId);
      if (sr) {
        const label = sr.source === "repo" ? ".claudette.json" : "settings";
        const status = sr.success
          ? "completed"
          : sr.timed_out
            ? "timed out"
            : "failed";
        addChatMessage(workspaceId, {
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          role: "System",
          content: `Setup script (${label}) ${status}${sr.output ? `:\n${sr.output}` : ""}`,
          cost_usd: null,
          duration_ms: null,
          created_at: new Date().toISOString(),
          thinking: null,
        });
      }
      closeModal();
      // Open MCP modal after setup script completes
      if (repoId) {
        openModal("mcpSelection", { workspaceId, repoId });
      }
    } catch (e) {
      addChatMessage(workspaceId, {
        id: crypto.randomUUID(),
        workspace_id: workspaceId,
        role: "System",
        content: `Setup script failed: ${e}`,
        cost_usd: null,
        duration_ms: null,
        created_at: new Date().toISOString(),
        thinking: null,
      });
      closeModal();
      // Open MCP modal even if setup script fails
      if (repoId) {
        openModal("mcpSelection", { workspaceId, repoId });
      }
    }
  };

  const handleSkip = () => {
    closeModal();
    // Open MCP modal when user skips setup script
    if (repoId) {
      openModal("mcpSelection", { workspaceId, repoId });
    }
  };

  const label = source === "repo" ? ".claudette.json" : "repo settings";

  return (
    <Modal title="Review Setup Script" onClose={closeModal}>
      <div className={shared.warning}>
        This workspace has a setup script from <strong>{label}</strong> that
        will be executed. Please review it before proceeding.
      </div>
      <div className={shared.field}>
        <label className={shared.label}>Script</label>
        <pre
          style={{
            background: "var(--chat-input-bg)",
            border: "1px solid var(--divider)",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 12,
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 200,
            overflow: "auto",
            margin: 0,
          }}
        >
          {script}
        </pre>
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={handleSkip}>
          Skip
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleRun}
          disabled={loading}
        >
          {loading ? "Running..." : "Run Script"}
        </button>
      </div>
    </Modal>
  );
}
