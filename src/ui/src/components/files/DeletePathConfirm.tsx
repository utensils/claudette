import { useTranslation } from "react-i18next";
import { SafeTrans } from "../shared/SafeTrans";
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
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const name = displayNameForPath(target.path);
  return (
    <Modal
      title={
        target.isDirectory
          ? t("files_delete_title_folder")
          : t("files_delete_title_file")
      }
      onClose={onClose}
    >
      <div className={shared.warning}>
        <SafeTrans
          i18nKey="files_delete_message"
          ns="modals"
          values={{ name }}
          components={{ strong: <strong /> }}
        />
        {dirtyCount > 0 && (
          <> {t("files_delete_dirty", { count: dirtyCount })}</>
        )}
      </div>
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button type="button" className={shared.btn} onClick={onClose} disabled={loading}>
          {tCommon("cancel")}
        </button>
        <button
          type="button"
          className={shared.btnDanger}
          onClick={onConfirm}
          disabled={loading}
          autoFocus
        >
          {loading ? t("files_delete_deleting") : tCommon("delete")}
        </button>
      </div>
    </Modal>
  );
}
