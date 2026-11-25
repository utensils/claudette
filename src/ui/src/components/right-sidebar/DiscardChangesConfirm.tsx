import { useCallback, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
      ? t("discard_title_bulk_untracked")
      : t("discard_title_bulk_unstaged")
    : isUntracked
      ? t("discard_title_untracked")
      : t("discard_title_unstaged");
  const action = isUntracked ? t("discard_action_delete") : t("discard_action_discard");
  const target = (
    <strong>
      {isBulk ? t("discard_files", { count: bulkCount }) : filePath}
    </strong>
  );
  const descriptionKey = isUntracked
    ? isBulk
      ? "discard_desc_bulk_untracked"
      : "discard_desc_untracked"
    : isBulk
      ? "discard_desc_bulk_unstaged"
      : "discard_desc_unstaged";
  const description = (
    <Trans
      i18nKey={descriptionKey}
      count={isBulk ? bulkCount : undefined}
      components={{ target, strong: <strong /> }}
    />
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
          {t("cancel")}
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
          {loading
            ? isUntracked
              ? t("discard_action_deleting")
              : t("discard_action_discarding")
            : action}
        </button>
      </div>
    </Modal>
  );
}
