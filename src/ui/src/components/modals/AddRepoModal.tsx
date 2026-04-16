import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../stores/useAppStore";
import { addRepository, getDefaultBranch, discoverWorktrees } from "../../services/tauri";
import { detectMcpServers } from "../../services/mcp";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function AddRepoModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const openModal = useAppStore((s) => s.openModal);
  const addRepo = useAppStore((s) => s.addRepository);
  const setDefaultBranches = useAppStore((s) => s.setDefaultBranches);
  const defaultBranches = useAppStore((s) => s.defaultBranches);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        setPath(selected);
        setError(null);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSubmit = async () => {
    if (!path.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const repo = await addRepository(path.trim());
      addRepo(repo);
      // Fetch default branch for the new repo.
      getDefaultBranch(repo.id).then((branch) => {
        if (branch) {
          setDefaultBranches({ ...defaultBranches, [repo.id]: branch });
        }
      });
      // Detect existing worktrees and MCP servers (both best-effort).
      let mcps: Awaited<ReturnType<typeof detectMcpServers>> = [];
      try {
        mcps = await detectMcpServers(repo.id);
      } catch {
        // MCP detection is best-effort.
      }

      try {
        const worktrees = await discoverWorktrees(repo.id);
        if (worktrees.length > 0) {
          openModal("importWorktrees", {
            repoId: repo.id,
            pendingMcps: mcps.length > 0 ? mcps : undefined,
          });
          return;
        }
      } catch {
        // Worktree discovery is best-effort.
      }

      if (mcps.length > 0) {
        openModal("mcpSelection", { repoId: repo.id });
        return;
      }
      closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Add Repository" onClose={closeModal}>
      <div className={shared.field}>
        <label className={shared.label}>Repository path</label>
        <div className={shared.inputRow}>
          <input
            className={shared.input}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/repository"
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            autoFocus
          />
          <button className={shared.btn} onClick={handleBrowse}>
            Browse
          </button>
        </div>
        {error && <div className={shared.error}>{error}</div>}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          Cancel
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleSubmit}
          disabled={loading || !path.trim()}
        >
          {loading ? "Adding..." : "Add"}
        </button>
      </div>
    </Modal>
  );
}
