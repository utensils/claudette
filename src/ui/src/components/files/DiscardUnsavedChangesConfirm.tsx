import { Modal } from "../modals/Modal";
import shared from "../modals/shared.module.css";

interface DiscardUnsavedChangesConfirmProps {
  /** Number of dirty files this confirmation covers. Defaults to 1.
   *  Drives the message wording so bulk-close prompts read naturally
   *  ("changes in 3 files" vs "changes in this file"). */
  count?: number;
  /** Called when the user opts to discard their unsaved changes. */
  onConfirm: () => void;
  /** Called when the user dismisses the modal (Cancel / backdrop / Esc). */
  onClose: () => void;
}

export function DiscardUnsavedChangesConfirm({
  count = 1,
  onConfirm,
  onClose,
}: DiscardUnsavedChangesConfirmProps) {
  const message =
    count > 1
      ? `You have unsaved changes in ${count} files. Closing these tabs will discard them.`
      : "You have unsaved changes in this file. Closing this tab will discard them.";
  return (
    <Modal title="Discard unsaved changes?" onClose={onClose}>
      <div className={shared.warning}>
        {message} <strong>This cannot be undone.</strong>
      </div>
      <div className={shared.actions}>
        <button type="button" className={shared.btn} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={shared.btnDanger}
          onClick={() => {
            onConfirm();
          }}
          autoFocus
        >
          Discard
        </button>
      </div>
    </Modal>
  );
}
