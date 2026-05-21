import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import {
  discoverWorktrees,
  importWorktrees,
  purgeStrayWorktree,
} from "../../services/tauri";
import type { DiscoveredWorktree, WorktreeImport } from "../../services/tauri";
import type { McpServer } from "../../types/mcp";
import { formatBytes } from "../../utils/formatBytes";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./ImportWorktreesModal.module.css";

const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

interface WorktreeRow extends DiscoveredWorktree {
  editedName: string;
}

export function ImportWorktreesModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
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
  const [purging, setPurging] = useState<Set<string>>(new Set());
  const [confirmPath, setConfirmPath] = useState<string | null>(null);

  useEffect(() => {
    if (!repoId) return;
    setLoading(true);

    discoverWorktrees(repoId)
      .then((discovered) => {
        if (discovered.length === 0) {
          // Nothing to import. In the add-repo onboarding chain, skip
          // ahead to MCP selection. Opened standalone (Repo Settings or
          // the sidebar context menu), fall through to the "none found"
          // render below so the user gets explicit feedback instead of
          // a modal that silently vanishes.
          if (pendingMcps && pendingMcps.length > 0) chainOrClose();
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

  const handlePurge = async (path: string) => {
    setPurging((prev) => new Set(prev).add(path));
    setError(null);
    try {
      await purgeStrayWorktree(repoId, path);
      setRows((prev) => prev.filter((r) => r.path !== path));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      // Only dismiss the confirm box on success — leaving it open on
      // error keeps the user in the path context they were acting on.
      setConfirmPath(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setPurging((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  };

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
      <Modal title={t("import_worktrees_title")} onClose={chainOrClose}>
        <div className={styles.loading}>{t("import_worktrees_scanning")}</div>
      </Modal>
    );
  }

  if (rows.length === 0) {
    return (
      <Modal title={t("import_worktrees_title")} onClose={chainOrClose}>
        <p className={styles.description}>
          {t("import_worktrees_none_found")}
        </p>
        <div className={shared.actions}>
          <button className={shared.btn} onClick={chainOrClose}>
            {tCommon("close")}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t("import_worktrees_found_title")} onClose={chainOrClose} wide>
      <p className={styles.description}>
        {t("import_worktrees_found_desc")}
      </p>

      <div className={styles.worktreeList}>
        {rows.map((row) => {
          const isSelected = selected.has(row.path);
          const nameValid = NAME_RE.test(row.editedName);
          const isPurging = purging.has(row.path);
          const size =
            row.size_bytes != null ? formatBytes(row.size_bytes) : null;
          return (
            <div key={row.path} className={styles.worktreeRow}>
              <label className={styles.worktreeSelect}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleRow(row.path)}
                  disabled={isPurging}
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
                      disabled={isPurging}
                    />
                    <span className={styles.badge}>{row.branch_name}</span>
                    {size && <span className={styles.sizeBadge}>{size}</span>}
                  </div>
                  <div className={styles.worktreePath}>{row.path}</div>
                </div>
              </label>
              <button
                type="button"
                className={styles.deleteButton}
                title={t("import_worktrees_delete_tooltip")}
                disabled={isPurging}
                onClick={() => setConfirmPath(row.path)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {confirmPath && (
        <div className={styles.confirmBox}>
          <div className={styles.confirmText}>
            {t("import_worktrees_delete_confirm", { path: confirmPath })}
          </div>
          {error && <div className={styles.confirmError}>{error}</div>}
          <div className={styles.confirmActions}>
            <button
              className={shared.btn}
              onClick={() => {
                setConfirmPath(null);
                setError(null);
              }}
              disabled={purging.has(confirmPath)}
            >
              {tCommon("cancel")}
            </button>
            <button
              className={shared.btnDanger}
              onClick={() => handlePurge(confirmPath)}
              disabled={purging.has(confirmPath)}
            >
              {purging.has(confirmPath)
                ? t("import_worktrees_deleting")
                : t("import_worktrees_delete_confirm_button")}
            </button>
          </div>
        </div>
      )}

      {/* Top-level error surfaces only when the confirm box isn't open
          — purge errors live inside the confirm box so the user keeps
          path context. Imports / other top-level failures still show
          here. */}
      {error && !confirmPath && <div className={shared.error}>{error}</div>}

      <div className={shared.actions}>
        <button className={shared.btn} onClick={chainOrClose}>
          {tCommon("skip")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleImport}
          disabled={importing || selected.size === 0 || !allNamesValid}
        >
          {importing
            ? t("import_worktrees_importing")
            : selected.size === 1
              ? t("import_worktrees_confirm_singular", { count: selected.size })
              : t("import_worktrees_confirm_plural", { count: selected.size })}
        </button>
      </div>
    </Modal>
  );
}
