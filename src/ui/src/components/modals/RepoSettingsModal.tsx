import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { updateRepositorySettings } from "../../services/tauri";
import { Modal } from "./Modal";
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!repo) return null;

  const handleSave = async () => {
    setLoading(true);
    setError(null);
    try {
      const iconValue = icon.trim() || null;
      await updateRepositorySettings(repoId, name.trim(), iconValue);
      updateRepo(repoId, { name: name.trim(), icon: iconValue });
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
        <label className={shared.label}>Icon (emoji or name)</label>
        <input
          className={shared.input}
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="e.g. rocket, code, bug"
        />
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
