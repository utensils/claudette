import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CornerDownRight,
  LoaderCircle,
  Pencil,
  SendHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type { QueuedMessage } from "../../stores/useAppStore";
import {
  isQueuedEditCancelShortcut,
  isQueuedEditSaveShortcut,
  resolveQueuedMentionFiles,
} from "./queuedMessageEditing";
import styles from "./ChatPanel.module.css";

interface QueuedMessageUpdates {
  content: string;
  mentionedFiles?: string[] | undefined;
}

interface QueuedMessagesPopoverProps {
  queuedMessages: QueuedMessage[];
  isRemote: boolean;
  isRunning: boolean;
  isSteeringQueued: boolean;
  steerQueuedTooltip: string;
  onEditingChange: (isEditing: boolean) => void;
  onClearQueue: () => void;
  onRemoveMessage: (queuedMessageId: string) => void;
  onSteerMessage: (queuedMessageId: string) => void;
  onUpdateMessage: (queuedMessageId: string, updates: QueuedMessageUpdates) => void;
}

export function QueuedMessagesPopover({
  queuedMessages,
  isRemote,
  isRunning,
  isSteeringQueued,
  steerQueuedTooltip,
  onEditingChange,
  onClearQueue,
  onRemoveMessage,
  onSteerMessage,
  onUpdateMessage,
}: QueuedMessagesPopoverProps) {
  const { t } = useTranslation("chat");
  const [editingQueuedMessageId, setEditingQueuedMessageId] = useState<string | null>(null);
  const [queuedEditDraft, setQueuedEditDraft] = useState("");
  const queuedEditRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    onEditingChange(!!editingQueuedMessageId);
  }, [editingQueuedMessageId, onEditingChange]);

  useEffect(() => {
    if (!editingQueuedMessageId) return;
    if (queuedMessages.some((message) => message.id === editingQueuedMessageId)) return;
    setEditingQueuedMessageId(null);
    setQueuedEditDraft("");
  }, [editingQueuedMessageId, queuedMessages]);

  useEffect(() => {
    if (!editingQueuedMessageId) return;
    const textarea = queuedEditRef.current;
    if (!textarea) return;
    textarea.focus();
    const cursor = textarea.value.length;
    textarea.setSelectionRange(cursor, cursor);
  }, [editingQueuedMessageId]);

  const cancelQueuedMessageEdit = () => {
    setEditingQueuedMessageId(null);
    setQueuedEditDraft("");
  };

  const startQueuedMessageEdit = (message: QueuedMessage) => {
    setEditingQueuedMessageId(message.id);
    setQueuedEditDraft(message.content);
  };

  const saveQueuedMessageEdit = () => {
    if (!editingQueuedMessageId) return;
    const queuedMessage = queuedMessages.find(
      (message) => message.id === editingQueuedMessageId,
    );
    if (!queuedMessage) {
      cancelQueuedMessageEdit();
      return;
    }

    const hasAttachments = (queuedMessage.attachments?.length ?? 0) > 0;
    if (queuedEditDraft.trim().length === 0 && !hasAttachments) return;

    onUpdateMessage(queuedMessage.id, {
      content: queuedEditDraft,
      mentionedFiles: resolveQueuedMentionFiles(
        queuedEditDraft,
        queuedMessage.mentionedFiles,
      ),
    });
    cancelQueuedMessageEdit();
  };

  const handleQueuedEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isQueuedEditSaveShortcut(e)) {
      e.preventDefault();
      saveQueuedMessageEdit();
      return;
    }
    if (isQueuedEditCancelShortcut(e)) {
      e.preventDefault();
      cancelQueuedMessageEdit();
    }
  };

  const removeQueuedMessageAndCancelEdit = (queuedMessageId: string) => {
    onRemoveMessage(queuedMessageId);
    if (editingQueuedMessageId === queuedMessageId) cancelQueuedMessageEdit();
  };

  return (
    <div className={styles.queuedPopover}>
      <div className={styles.queuedPopoverHeader}>
        <span className={styles.queuedLabel}>
          {t("queued_label")} · {queuedMessages.length}
        </span>
        <button
          className={styles.queuedClearAll}
          onClick={onClearQueue}
          title={t("clear_queue")}
          aria-label={t("clear_queue")}
        >
          {t("clear_queue")}
        </button>
      </div>
      <div className={styles.queuedList}>
        {queuedMessages.map((message) => {
          const content = message.content.trim();
          const fallback = message.attachments?.length
            ? message.attachments.map((attachment) => attachment.filename).join(", ")
            : t("queued_attachment_fallback");
          const isEditing = editingQueuedMessageId === message.id;
          const canSaveEdit =
            queuedEditDraft.trim().length > 0 || (message.attachments?.length ?? 0) > 0;
          return (
            <div
              className={`${styles.queuedMessage}${isEditing ? ` ${styles.queuedMessageEditing}` : ""}`}
              key={message.id}
            >
              <span className={styles.queuedIcon} aria-hidden="true">
                <CornerDownRight size={14} />
              </span>
              {isEditing ? (
                <div className={styles.queuedEditForm}>
                  <textarea
                    ref={queuedEditRef}
                    className={styles.queuedEditTextarea}
                    value={queuedEditDraft}
                    rows={2}
                    onChange={(e) => setQueuedEditDraft(e.target.value)}
                    onKeyDown={handleQueuedEditKeyDown}
                    placeholder={fallback}
                    aria-label={t("edit_queued")}
                    spellCheck={false}
                  />
                  <div className={styles.queuedEditActions}>
                    <button
                      className={styles.queuedEditSave}
                      onClick={saveQueuedMessageEdit}
                      disabled={!canSaveEdit}
                      title={t("save_queued_edit")}
                      aria-label={t("save_queued_edit")}
                    >
                      <Check size={14} />
                    </button>
                    <button
                      className={styles.queuedEditCancel}
                      onClick={cancelQueuedMessageEdit}
                      title={t("cancel_queued_edit")}
                      aria-label={t("cancel_queued_edit")}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span className={styles.queuedContent}>{content || fallback}</span>
                  <button
                    className={styles.queuedEdit}
                    onClick={() => startQueuedMessageEdit(message)}
                    title={t("edit_queued")}
                    aria-label={t("edit_queued")}
                  >
                    <Pencil size={14} />
                  </button>
                  {!isRemote && (
                    <button
                      className={styles.queuedSteer}
                      onClick={() => onSteerMessage(message.id)}
                      disabled={isSteeringQueued || !isRunning}
                      data-tooltip={steerQueuedTooltip}
                      aria-label={t("steer_queued")}
                    >
                      {isSteeringQueued ? (
                        <LoaderCircle size={14} className={styles.queuedSteerSpinner} />
                      ) : (
                        <SendHorizontal size={14} />
                      )}
                      <span>{t("steer_queued_short")}</span>
                    </button>
                  )}
                </>
              )}
              <button
                className={styles.queuedCancel}
                onClick={() => removeQueuedMessageAndCancelEdit(message.id)}
                title={t("cancel_queued")}
                aria-label={t("cancel_queued")}
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
