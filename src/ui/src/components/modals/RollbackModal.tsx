import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import {
  rollbackToCheckpoint,
  clearConversation,
  loadDiffFiles,
  loadCompletedTurns,
  loadAttachmentsForSession,
  loadAttachmentData,
} from "../../services/tauri";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function RollbackModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const rollbackConversation = useAppStore((s) => s.rollbackConversation);
  const setChatInputPrefill = useAppStore((s) => s.setChatInputPrefill);
  const setDiffFiles = useAppStore((s) => s.setDiffFiles);
  const clearDiff = useAppStore((s) => s.clearDiff);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(false);

  const workspaceId = modalData.workspaceId as string;
  const sessionId = modalData.sessionId as string;
  const checkpointId = (modalData.checkpointId as string) ?? null;
  const messageId = (modalData.messageId as string) ?? null;
  const messagePreview = modalData.messagePreview as string;
  const messageContent = (modalData.messageContent as string) ?? "";
  const hasFileChanges = modalData.hasFileChanges as boolean;
  const isClearAll = !checkpointId;

  const handleRollback = async () => {
    setLoading(true);
    try {
      const rolledBackAtts = messageId
        ? (useAppStore.getState().chatAttachments[sessionId] ?? []).filter(
            (a) => a.message_id === messageId,
          )
        : [];

      const messages = isClearAll
        ? await clearConversation(sessionId, restoreFiles)
        : await rollbackToCheckpoint(sessionId, checkpointId, restoreFiles);
      rollbackConversation(
        sessionId,
        workspaceId,
        checkpointId ?? "__clear__",
        messages,
      );
      loadCompletedTurns(sessionId)
        .then((turnData) => {
          const turns = reconstructCompletedTurns(messages, turnData);
          useAppStore.getState().setCompletedTurns(sessionId, turns);
        })
        .catch((e) => console.error("Failed to reload turns after rollback:", e));
      if (messageContent) {
        setChatInputPrefill(messageContent);
      }
      if (rolledBackAtts.length > 0) {
        const prefillAtts = await Promise.all(
          rolledBackAtts.map(async (a) => {
            let data = a.data_base64;
            if (!data && a.id) {
              data = await loadAttachmentData(a.id).catch(() => "");
            }
            return {
              filename: a.filename,
              media_type: a.media_type,
              data_base64: data,
            };
          }),
        );
        useAppStore
          .getState()
          .setPendingAttachmentsPrefill(prefillAtts.filter((a) => a.data_base64));
      }
      loadAttachmentsForSession(sessionId)
        .then((atts) => useAppStore.getState().setChatAttachments(sessionId, atts))
        .catch((e) => console.error("Failed to reload attachments after rollback:", e));
      clearDiff();
      loadDiffFiles(workspaceId)
        .then((result) => setDiffFiles(result.files, result.merge_base))
        .catch((e) => console.error("Failed to refresh diff after rollback:", e));
      closeModal();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <Modal title={t("rollback_title")} onClose={closeModal}>
      <div className={shared.warning}>
        {isClearAll ? t("rollback_clear_all") : t("rollback_to_before")}
        {messagePreview && (
          <div className={shared.quoteLine}>
            &ldquo;{messagePreview}
            {messagePreview.length >= 100 ? "..." : ""}
            &rdquo;
          </div>
        )}
      </div>
      {hasFileChanges && (
        <label className={shared.checkboxRow}>
          <input
            type="checkbox"
            checked={restoreFiles}
            onChange={(e) => setRestoreFiles(e.target.checked)}
          />
          <span>{t("rollback_restore_files")}</span>
        </label>
      )}
      {error && <div className={shared.error}>{error}</div>}
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {tCommon("cancel")}
        </button>
        <button
          className={shared.btnDanger}
          onClick={handleRollback}
          disabled={loading}
        >
          {loading ? t("rollback_rolling_back") : t("rollback_confirm")}
        </button>
      </div>
    </Modal>
  );
}
