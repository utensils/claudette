import { useCallback, useState, type ReactNode } from "react";
import { Modal } from "../modals/Modal";
import shared from "../modals/shared.module.css";
import type { DiffLayer } from "../../types/diff";

export type DiscardableLayer = Extract<DiffLayer, "unstaged" | "untracked">;

type DiscardChangesConfirmProps = {
  layer: DiscardableLayer;
  onConfirm: () => Promise<void>;
  onClose: () => void;
} & (
  | { filePath: string; bulkCount?: never }
  | { bulkCount: number; filePath?: never }
);

export function DiscardChangesConfirm({
  filePath,
  bulkCount,
  layer,
  onConfirm,
  onClose,
}: DiscardChangesConfirmProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }, [onConfirm, onClose]);

  // Block backdrop dismiss while the discard is in flight, matching the
  // disabled Cancel button below.
  const handleClose = () => {
    if (loading) return;
    onClose();
  };

  const isUntracked = layer === "untracked";
  const isBulk = bulkCount != null && bulkCount > 0;
  const title = isBulk
    ? isUntracked
      ? "Delete all untracked files?"
      : "Discard all unstaged changes?"
    : isUntracked
      ? "Delete untracked file?"
      : "Discard changes?";
  const action = isUntracked ? "Delete" : "Discard";
  const target: ReactNode = isBulk ? (
    <strong>
      {bulkCount} file{bulkCount === 1 ? "" : "s"}
    </strong>
  ) : (
    <strong>{filePath}</strong>
  );
  const description = isUntracked ? (
    isBulk ? (
      <>
        Delete {target} that {bulkCount === 1 ? "is" : "are"} not tracked by
        git. They will be removed from disk.{" "}
        <strong>This cannot be undone.</strong>
      </>
    ) : (
      <>
        The file {target} is not tracked by git. Deleting it will remove it
        from disk. <strong>This cannot be undone.</strong>
      </>
    )
  ) : isBulk ? (
    <>
      Discard unstaged changes across {target}. Files will be restored from
      the index. Any staged changes are kept.{" "}
      <strong>This cannot be undone.</strong>
    </>
  ) : (
    <>
      Discard unstaged changes to {target}. The file will be restored from the
      index. Any staged changes are kept.{" "}
      <strong>This cannot be undone.</strong>
    </>
  );

  return (
    <Modal title={title} onClose={handleClose}>
      <div className={shared.warning}>{description}</div>
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button
          className={shared.btn}
          onClick={handleClose}
          disabled={loading}
          type="button"
        >
          Cancel
        </button>
        <button
          className={shared.btnDanger}
          onClick={handleConfirm}
          disabled={loading}
          type="button"
          // Auto-focus the primary action so Enter activates it via the
          // browser's native button keyboard handling. A window-level
          // keydown listener was tried earlier but raced with other
          // global Enter handlers in the app and could double-fire the
          // confirm if the button was already focused.
          autoFocus
        >
          {loading ? `${action}ing…` : action}
        </button>
      </div>
    </Modal>
  );
}
