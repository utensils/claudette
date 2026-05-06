import { Modal } from "../modals/Modal";
import shared from "../modals/shared.module.css";
import { displayNameForPath, type FileContextTarget } from "./fileContextMenu";

interface DeletePathConfirmProps {
  target: FileContextTarget;
  dirtyCount: number;
  loading: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeletePathConfirm({
  target,
  dirtyCount,
  loading,
  error,
  onConfirm,
  onClose,
}: DeletePathConfirmProps) {
  const noun = target.isDirectory ? "folder" : "file";
  const name = displayNameForPath(target.path);
  return (
    <Modal title={`Delete ${noun}?`} onClose={onClose}>
      <div className={shared.warning}>
        Move <strong>{name}</strong> to Trash?
        {dirtyCount > 0 && (
          <>
            {" "}
            Unsaved changes in {dirtyCount === 1 ? "this file" : `${dirtyCount} files`} will
            be discarded.
          </>
        )}
      </div>
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button type="button" className={shared.btn} onClick={onClose} disabled={loading}>
          Cancel
        </button>
        <button
          type="button"
          className={shared.btnDanger}
          onClick={onConfirm}
          disabled={loading}
          autoFocus
        >
          {loading ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}
