import { AttachmentCardShell } from "./AttachmentCardShell";
import { useAttachmentText } from "./useAttachmentText";
import styles from "./MessageAttachment.module.css";

/** Inline preview for a plain-text attachment: monospace block in a
 *  collapsible card. Replaces the prior 1-line "FileText + filename + size"
 *  badge so logs and other text artifacts get an actual preview rather than
 *  a download chip. */
export function TextAttachmentCard({
  attachmentId,
  text_content,
  data_base64,
  filename,
  size_bytes,
  onContextMenu,
}: {
  attachmentId?: string;
  text_content?: string | null;
  data_base64?: string | null;
  filename: string;
  size_bytes: number;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { text, error } = useAttachmentText({
    text_content,
    data_base64,
    attachmentId,
  });

  return (
    <AttachmentCardShell
      filename={filename}
      mediaType="text/plain"
      sizeBytes={size_bytes}
      collapsible
      onContextMenu={onContextMenu}
    >
      {error ? (
        <div className={styles.error}>Failed to load: {error}</div>
      ) : text === null ? (
        <div className={styles.error}>Loading…</div>
      ) : (
        <pre className={styles.preBody}>{text}</pre>
      )}
    </AttachmentCardShell>
  );
}
