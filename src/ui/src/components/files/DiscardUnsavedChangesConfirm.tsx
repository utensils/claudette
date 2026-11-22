import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  return (
    <Modal title={t("discard_unsaved_title")} onClose={onClose}>
      <div className={shared.warning}>
        {t("discard_unsaved_message", { count })}{" "}
        <strong>{t("discard_unsaved_irreversible")}</strong>
      </div>
      <div className={shared.actions}>
        <button type="button" className={shared.btn} onClick={onClose}>
          {tCommon("cancel")}
        </button>
        <button
          type="button"
          className={shared.btnDanger}
          onClick={() => {
            onConfirm();
          }}
          autoFocus
        >
          {t("discard_unsaved_confirm")}
        </button>
      </div>
    </Modal>
  );
}
