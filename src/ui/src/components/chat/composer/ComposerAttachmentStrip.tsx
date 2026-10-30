import type React from "react";
import { useTranslation } from "react-i18next";
import { FileText, X } from "lucide-react";
import type { PendingAttachment } from "../../../types/chat";
import { isTextFile } from "../../../utils/attachmentValidation";
import { type DownloadableAttachment } from "../../../utils/attachmentDownload";
import styles from "../ChatPanel.module.css";

/** Thumbnail strip of the composer's pending attachments. Renders nothing
 *  when there are no attachments. */
export function ComposerAttachmentStrip({
  attachments,
  onRemove,
  onAttachmentClick,
  onAttachmentContextMenu,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
  onAttachmentClick?: (
    e: React.MouseEvent,
    attachment: DownloadableAttachment,
  ) => void;
  onAttachmentContextMenu?: (
    e: React.MouseEvent,
    attachment: DownloadableAttachment,
  ) => void;
}) {
  const { t } = useTranslation("chat");
  if (attachments.length === 0) return null;
  return (
    <div className={styles.attachmentStrip}>
      {attachments.map((att) => (
        <div key={att.id} className={styles.attachmentThumb} title={att.filename}>
          {isTextFile(att.media_type) || !att.preview_url ? (
            // No preview URL: text files (always show filename
            // chip) AND non-image attachments rehydrated from the
            // slice without their thumbnail (PDFs lose their
            // first-page render on composer remount because the
            // underlying Blob is GC'd; the slice only stores
            // `data_base64`, not the transient thumbnail URL).
            // Without this fallback the row rendered as a broken
            // <img> after a remount even though the attachment
            // would still send correctly. The badge layout is
            // identical in both cases — file icon + name + size.
            <div className={styles.textFileBadge}>
              <FileText size={16} />
              <span className={styles.textFileName}>{att.filename}</span>
              <span className={styles.textFileSize}>
                {att.size_bytes < 1024
                  ? `${att.size_bytes} B`
                  : `${(att.size_bytes / 1024).toFixed(0)} KB`}
              </span>
            </div>
          ) : (
            <img
              src={att.preview_url}
              alt={att.filename}
              onClick={(e) => {
                // PDFs also render as an <img> here (preview_url is a blob
                // URL of the first-page thumbnail), but their data_base64
                // is PDF bytes — not renderable inside an <img>. Only open
                // the lightbox for actual image MIME types.
                if (!att.media_type.startsWith("image/")) return;
                onAttachmentClick?.(e, {
                  filename: att.filename,
                  media_type: att.media_type,
                  data_base64: att.data_base64,
                });
              }}
              onContextMenu={(e) =>
                onAttachmentContextMenu?.(e, {
                  filename: att.filename,
                  media_type: att.media_type,
                  data_base64: att.data_base64,
                })
              }
            />
          )}
          <button
            className={styles.attachmentRemove}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(att.id);
            }}
            title={t("remove_attachment")}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
