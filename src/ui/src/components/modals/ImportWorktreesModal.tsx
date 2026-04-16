import { useEffect, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  discoverWorktrees,
  importWorktrees,
} from "../../services/tauri";
import type { DiscoveredWorktree, WorktreeImport } from "../../services/tauri";
import type { McpServer } from "../../types/mcp";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./ImportWorktreesModal.module.css";

const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

interface WorktreeRow extends DiscoveredWorktree {
  editedName: string;
}

export function ImportWorktreesModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const openModal = useAppStore((s) => s.openModal);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const modalData = useAppStore((s) => s.modalData);
  const repoId = modalData.repoId as string;
  const pendingMcps = modalData.pendingMcps as McpServer[] | undefined;

  const [rows, setRows] = useState<WorktreeRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId) return;
    setLoading(true);

    discoverWorktrees(repoId)
      .then((discovered) => {
        if (discovered.length === 0) {
          chainOrClose();
          return;
        }
        const mapped = discovered.map((wt) => ({
          ...wt,
          editedName: wt.suggested_name,
        }));
        setRows(mapped);
        setSelected(new Set(discovered.map((wt) => wt.path)));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  const chainOrClose = () => {
    if (pendingMcps && pendingMcps.length > 0) {
      openModal("mcpSelection", { repoId, detectedMcps: pendingMcps });
    } else {
      closeModal();
    }
  };

  const toggleRow = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const updateName = (path: string, name: string) => {
    setRows((prev) =>
      prev.map((r) => (r.path === path ? { ...r, editedName: name } : r))
    );
  };

  const selectedRows = rows.filter((r) => selected.has(r.path));
  const allNamesValid = selectedRows.every((r) => NAME_RE.test(r.editedName));

  const handleImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const imports: WorktreeImport[] = selectedRows.map((r) => ({
        path: r.path,
        branch_name: r.branch_name,
        name: r.editedName,
      }));
      const created = await importWorktrees(repoId, imports);
      for (const ws of created) {
        addWorkspace(ws);
      }
      chainOrClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  };

  if (loading) {
    return (
      <Modal title="Import Worktrees" onClose={chainOrClose}>
        <div className={styles.loading}>Scanning for existing worktrees...</div>
      </Modal>
    );
  }

  if (rows.length === 0) {
    return (
      <Modal title="Import Worktrees" onClose={chainOrClose}>
        <p className={styles.description}>
          No existing worktrees found for this repository.
        </p>
        <div className={shared.actions}>
          <button className={shared.btn} onClick={chainOrClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Existing Worktrees Found" onClose={chainOrClose}>
      <p className={styles.description}>
        These git worktrees already exist for this repository.
        Select which ones to import as workspaces:
      </p>

      <div className={styles.worktreeList}>
        {rows.map((row) => {
          const isSelected = selected.has(row.path);
          const nameValid = NAME_RE.test(row.editedName);
          return (
            <label key={row.path} className={styles.worktreeRow}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => toggleRow(row.path)}
              />
              <div className={styles.worktreeInfo}>
                <div className={styles.worktreeHeader}>
                  <input
                    type="text"
                    className={
                      isSelected && !nameValid
                        ? styles.nameInputInvalid
                        : styles.nameInput
                    }
                    value={row.editedName}
                    onChange={(e) => {
                      e.stopPropagation();
                      updateName(row.path, e.target.value);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className={styles.badge}>{row.branch_name}</span>
                </div>
                <div className={styles.worktreePath}>{row.path}</div>
              </div>
            </label>
          );
        })}
      </div>

      {error && <div className={shared.error}>{error}</div>}

      <div className={shared.actions}>
        <button className={shared.btn} onClick={chainOrClose}>
          Skip
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleImport}
          disabled={importing || selected.size === 0 || !allNamesValid}
        >
          {importing
            ? "Importing..."
            : `Import ${selected.size} Workspace${selected.size !== 1 ? "s" : ""}`}
        </button>
      </div>
    </Modal>
  );
}
