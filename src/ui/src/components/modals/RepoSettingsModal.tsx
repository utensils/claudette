import { useState, useEffect } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { updateRepositorySettings, getRepoConfig } from "../../services/tauri";
import type { RepoConfigInfo } from "../../types/repository";
import { Modal } from "./Modal";
import { IconPicker } from "./IconPicker";
import shared from "./shared.module.css";

export function RepoSettingsModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const openModal = useAppStore((s) => s.openModal);
  const modalData = useAppStore((s) => s.modalData);
  const updateRepo = useAppStore((s) => s.updateRepository);
  const repositories = useAppStore((s) => s.repositories);

  const repoId = modalData.repoId as string;
  const repo = repositories.find((r) => r.id === repoId);

  const [name, setName] = useState(repo?.name ?? "");
  const [icon, setIcon] = useState(repo?.icon ?? "");
  const [setupScript, setSetupScript] = useState(repo?.setup_script ?? "");
  const [customInstructions, setCustomInstructions] = useState(
    repo?.custom_instructions ?? ""
  );
  const [branchRenamePreferences, setBranchRenamePreferences] = useState(
    repo?.branch_rename_preferences ?? ""
  );
  const [branchPrefsOpen, setBranchPrefsOpen] = useState(
    !!repo?.branch_rename_preferences
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [repoConfig, setRepoConfig] = useState<RepoConfigInfo | null>(null);

  useEffect(() => {
    if (repoId) {
      getRepoConfig(repoId)
        .then(setRepoConfig)
        .catch(() => setRepoConfig(null));
    }
  }, [repoId]);

  if (!repo) return null;

  const repoScriptOverrides =
    repoConfig?.has_config_file && repoConfig.setup_script != null;
  const repoInstructionsOverrides =
    repoConfig?.has_config_file && repoConfig.instructions != null;

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    try {
      const iconValue = icon.trim() || null;
      const scriptValue = setupScript.trim() || null;
      const instructionsValue = customInstructions.trim() || null;
      const branchPrefsValue = branchRenamePreferences.trim() || null;
      await updateRepositorySettings(
        repoId,
        name.trim(),
        iconValue,
        scriptValue,
        instructionsValue,
        branchPrefsValue
      );
      updateRepo(repoId, {
        name: name.trim(),
        icon: iconValue,
        setup_script: scriptValue,
        custom_instructions: instructionsValue,
        branch_rename_preferences: branchPrefsValue,
      });
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Repository Settings" onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>Display Name</label>
        <input
          className={shared.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </div>
      <div className={shared.field}>
        <label className={shared.label}>Icon</label>
        <IconPicker value={icon} onChange={setIcon} />
      </div>

      <div
        style={{
          borderTop: "1px solid var(--divider)",
          marginTop: 16,
          paddingTop: 12,
        }}
      >
        <label className={shared.label}>Setup Script</label>
        {repoConfig?.parse_error && (
          <div className={shared.error} style={{ marginBottom: 8 }}>
            {repoConfig.parse_error}
          </div>
        )}
        {repoScriptOverrides && (
          <div className={shared.hint} style={{ marginBottom: 8 }}>
            This repo includes a <code>.claudette.json</code> that defines a
            setup script. Repo-level scripts take precedence over your personal
            setup script.
          </div>
        )}
        {repoConfig?.has_config_file && repoConfig.setup_script && (
          <div style={{ marginBottom: 8 }}>
            <div
              className={shared.label}
              style={{ fontSize: 11, marginBottom: 2 }}
            >
              From .claudette.json (read-only):
            </div>
            <pre
              style={{
                background: "var(--chat-input-bg)",
                border: "1px solid var(--divider)",
                borderRadius: 4,
                padding: "6px 8px",
                fontSize: 12,
                color: "var(--text-dim)",
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {repoConfig.setup_script}
            </pre>
          </div>
        )}
        <div className={shared.label} style={{ fontSize: 11, marginBottom: 2 }}>
          Personal setup script{repoScriptOverrides ? " (overridden)" : ""}:
        </div>
        <textarea
          className={shared.input}
          value={setupScript}
          onChange={(e) => setSetupScript(e.target.value)}
          placeholder="e.g. mise trust && mise install"
          rows={3}
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            resize: "vertical",
            opacity: repoScriptOverrides ? 0.5 : 1,
          }}
        />
        <div className={shared.hint}>
          Runs automatically when a new workspace is created.
        </div>
      </div>

      <div
        style={{
          borderTop: "1px solid var(--divider)",
          marginTop: 16,
          paddingTop: 12,
        }}
      >
        <label className={shared.label}>Custom Instructions</label>
        {repoInstructionsOverrides && (
          <div className={shared.hint} style={{ marginBottom: 8 }}>
            This repo includes a <code>.claudette.json</code> that defines
            custom instructions. Repo-level instructions take precedence over
            your personal instructions.
          </div>
        )}
        {repoConfig?.has_config_file && repoConfig.instructions && (
          <div style={{ marginBottom: 8 }}>
            <div
              className={shared.label}
              style={{ fontSize: 11, marginBottom: 2 }}
            >
              From .claudette.json (read-only):
            </div>
            <pre
              style={{
                background: "var(--chat-input-bg)",
                border: "1px solid var(--divider)",
                borderRadius: 4,
                padding: "6px 8px",
                fontSize: 12,
                color: "var(--text-dim)",
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {repoConfig.instructions}
            </pre>
          </div>
        )}
        <div className={shared.label} style={{ fontSize: 11, marginBottom: 2 }}>
          Personal instructions{repoInstructionsOverrides ? " (overridden)" : ""}:
        </div>
        <textarea
          className={shared.input}
          value={customInstructions}
          onChange={(e) => setCustomInstructions(e.target.value)}
          placeholder="e.g. Always use TypeScript. Prefer functional components."
          rows={4}
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            resize: "vertical",
            opacity: repoInstructionsOverrides ? 0.5 : 1,
          }}
        />
        <div className={shared.hint}>
          Appended to the agent's system prompt at the start of every chat.
        </div>
      </div>

      <div
        style={{
          borderTop: "1px solid var(--divider)",
          marginTop: 16,
          paddingTop: 12,
        }}
      >
        <div
          onClick={() => setBranchPrefsOpen(!branchPrefsOpen)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <label className={shared.label} style={{ cursor: "pointer", marginBottom: 0 }}>
            Branch rename preferences
          </label>
          <span
            style={{
              color: "var(--text-dim)",
              fontSize: 12,
              transform: branchPrefsOpen ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s ease",
            }}
          >
            ▾
          </span>
        </div>
        {branchPrefsOpen && (
          <div style={{ marginTop: 8 }}>
            <div className={shared.hint} style={{ marginBottom: 8 }}>
              Add custom instructions sent to the agent along with your first
              message in a workspace where the branch hasn't already been
              renamed.
            </div>
            <textarea
              className={shared.input}
              value={branchRenamePreferences}
              onChange={(e) => setBranchRenamePreferences(e.target.value)}
              placeholder="Add your preferences here. The agent will be told to prioritize these instructions over its default instructions."
              rows={3}
              style={{
                fontFamily: "monospace",
                fontSize: 12,
                resize: "vertical",
              }}
            />
          </div>
        )}
      </div>

      <div
        style={{
          borderTop: "1px solid var(--divider)",
          marginTop: 16,
          paddingTop: 12,
        }}
      >
        <div className={shared.label} style={{ color: "var(--status-stopped)" }}>
          Danger Zone
        </div>
        <button
          className={shared.btnDanger}
          onClick={() =>
            openModal("removeRepo", { repoId, repoName: repo.name })
          }
          style={{ marginTop: 8 }}
        >
          Remove Repository
        </button>
      </div>

      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          Cancel
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSave}
          disabled={loading || !name.trim()}
        >
          {loading ? "Saving..." : "Save"}
        </button>
      </div>
    </Modal>
  );
}
