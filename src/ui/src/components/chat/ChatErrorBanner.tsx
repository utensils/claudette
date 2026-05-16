import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { useWorkspaceLifecycle } from "../../hooks/useWorkspaceLifecycle";
import { isContextWindowError } from "./contextOverflowDetection";
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
  /** Active chat session — needed for the context-overflow recovery
   *  affordance, which opens that session's model picker. */
  sessionId?: string | null;
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
export function ChatErrorBanner({
  message,
  workspaceId,
  sessionId,
  onRecovered,
}: Props) {
  const { t } = useTranslation("chat");
  const openMissingCliModal = useAppStore((s) => s.openMissingCliModal);
  const setLastMissingWorktree = useAppStore((s) => s.setLastMissingWorktree);
  const setModelSelectorOpen = useAppStore((s) => s.setModelSelectorOpen);
  const { archive, restore } = useWorkspaceLifecycle();
  const [busy, setBusy] = useState<"archive" | "recreate" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The Archive action deselects the workspace mid-await, which usually
  // unmounts this banner before our `await archive(...)` resolves. Guard
  // post-await `setBusy` / `setActionError` calls so React doesn't warn
  // about state updates on an unmounted component (and so a slow rollback
  // landing after the user navigated away doesn't briefly resurrect the
  // error UI). Using a ref rather than the state itself because the
  // reads happen inside async functions that already captured the
  // component's render-time closures.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isMissingCli = / is not installed\./.test(message);
  const isMissingWorktree = /^Workspace directory is missing:/.test(message);
  const isContextOverflow = isContextWindowError(message);

  async function onArchive() {
    if (!workspaceId || busy) return;
    setActionError(null);
    setBusy("archive");
    // The worktree is already gone, so any repo archive_script that would
    // chdir into it would fail anyway — short-circuit it. This also means
    // the Sidebar's archive-script confirmation modal is intentionally
    // bypassed for this recovery surface (cf. useWorkspaceLifecycle docs).
    const result = await archive(workspaceId, { skipScript: true });
    if (result.ok) {
      // The store-level `selectWorkspace(null)` inside `archive` will
      // typically have already unmounted us — these calls are then
      // best-effort no-ops, which is fine: the parent's `onRecovered`
      // is the only side-effect that matters in the success path, and
      // the empty-state mounted in our place doesn't care about our
      // local `busy` / `actionError` state.
      if (mountedRef.current) {
        setBusy(null);
        setLastMissingWorktree(null);
      }
      onRecovered?.();
    } else if (mountedRef.current) {
      setBusy(null);
      setActionError(
        t("missing_worktree_archive_failed", { error: String(result.error) }),
      );
    }
  }

  async function onRecreate() {
    if (!workspaceId || busy) return;
    setActionError(null);
    setBusy("recreate");
    // `restore` re-runs `git worktree add` for the workspace's saved
    // branch and re-marks the workspace Active. Idempotent enough to
    // retry on transient failures.
    const result = await restore(workspaceId);
    if (!mountedRef.current) return;
    setBusy(null);
    if (result.ok) {
      setLastMissingWorktree(null);
      onRecovered?.();
    } else {
      setActionError(
        t("missing_worktree_recreate_failed", { error: String(result.error) }),
      );
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
      {isContextOverflow && sessionId && (
        <>
          {" "}
          <button
            type="button"
            className={styles.inlineLink}
            onClick={() => setModelSelectorOpen(true)}
          >
            {t("context_overflow_pick_model")} →
          </button>
        </>
      )}
      {actionError && <div className={styles.actionError}>{actionError}</div>}
    </div>
  );
}
