import { Modal } from "../modals/Modal";
import shared from "../modals/shared.module.css";

interface DiscardUnsavedChangesConfirmProps {
  /** Called when the user opts to discard their unsaved changes. */
  onConfirm: () => void;
  /** Called when the user dismisses the modal (Cancel / backdrop / Esc). */
  onClose: () => void;
}

export function DiscardUnsavedChangesConfirm({
  onConfirm,
  onClose,
}: DiscardUnsavedChangesConfirmProps) {
  return (
    <Modal title="Discard unsaved changes?" onClose={onClose}>
      <div className={shared.warning}>
        You have unsaved changes in the open file. Switching files will
        discard them. <strong>This cannot be undone.</strong>
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
