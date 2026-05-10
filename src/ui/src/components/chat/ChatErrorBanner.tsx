import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { archiveWorkspace, restoreWorkspace } from "../../services/tauri";
import styles from "./ChatErrorBanner.module.css";
import chatStyles from "./ChatPanel.module.css";

interface Props {
  /** The full error message returned from the chat send (already
   *  human-readable — see `src-tauri/src/missing_cli.rs::friendly_message`
   *  and `missing_worktree_message`). */
  message: string;
  /** Workspace whose chat surfaced this error — needed for archive /
   *  recreate actions on a missing-worktree banner. */
  workspaceId: string | null;
  /** Callback invoked when the user takes a recovery action that should
   *  clear the error. The parent owns error state; we just notify. */
  onRecovered?: () => void;
}

/**
 * Renders the chat error banner with on-demand recovery affordances for two
 * structured error classes the backend reports:
 *
 *  1. **Missing CLI** — `claude` (or another required CLI) isn't on PATH.
 *     The CLI is *optional* for many Claudette workflows, so the banner
 *     intentionally does NOT auto-pop a modal; instead it offers an inline
 *     "View install options" link that opens `MissingCliModal` on demand.
 *
 *  2. **Missing worktree** — the workspace's worktree directory has been
 *     deleted out from under us. Archive or recreate are the typical
 *     recovery paths; we expose both as buttons.
 *
 * Detection is intentionally text-prefix based — the error string format is
 * a stable contract owned by `src-tauri/src/missing_cli.rs`, and a brittle
 * structured-payload detour through React state would only buy us
 * negligibly more robustness while making both surfaces harder to evolve
 * independently.
 */
export function ChatErrorBanner({ message, workspaceId, onRecovered }: Props) {
  const { t } = useTranslation("chat");
  const openMissingCliModal = useAppStore((s) => s.openMissingCliModal);
  const setLastMissingWorktree = useAppStore((s) => s.setLastMissingWorktree);
  const [busy, setBusy] = useState<"archive" | "recreate" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isMissingCli = / is not installed\./.test(message);
  const isMissingWorktree = /^Workspace directory is missing:/.test(message);

  async function onArchive() {
    if (!workspaceId || busy) return;
    setActionError(null);
    setBusy("archive");
    try {
      await archiveWorkspace(workspaceId);
      setLastMissingWorktree(null);
      onRecovered?.();
    } catch (e) {
      setActionError(t("missing_worktree_archive_failed", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  }

  async function onRecreate() {
    if (!workspaceId || busy) return;
    setActionError(null);
    setBusy("recreate");
    try {
      // `restore_workspace` re-runs `git worktree add` for the workspace's
      // saved branch and re-marks the workspace Active. Idempotent enough
      // to retry on transient failures.
      await restoreWorkspace(workspaceId);
      setLastMissingWorktree(null);
      onRecovered?.();
    } catch (e) {
      setActionError(t("missing_worktree_recreate_failed", { error: String(e) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={chatStyles.errorBanner}>
      <span>{message}</span>
      {isMissingCli && (
        <>
          {" "}
          <button
            type="button"
            className={styles.inlineLink}
            onClick={openMissingCliModal}
          >
            {t("missing_cli_inline_link")} →
          </button>
        </>
      )}
      {isMissingWorktree && workspaceId && (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actionButton}
            onClick={onArchive}
            disabled={busy !== null}
          >
            {t("missing_worktree_archive")}
          </button>
          <button
            type="button"
            className={styles.actionButton}
            onClick={onRecreate}
            disabled={busy !== null}
          >
            {t("missing_worktree_recreate")}
          </button>
        </div>
      )}
      {actionError && <div className={styles.actionError}>{actionError}</div>}
    </div>
  );
}
