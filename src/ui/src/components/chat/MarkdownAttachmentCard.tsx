import { AttachmentCardShell } from "./AttachmentCardShell";
import { MessageMarkdown } from "./MessageMarkdown";
import { useAttachmentText } from "./useAttachmentText";
import styles from "./MessageAttachment.module.css";

/** Inline preview for a Markdown attachment: rendered through the same
 *  pipeline used for assistant messages so headings, lists, code blocks
 *  match the chat surface. Body collapses past ~320px. */
export function MarkdownAttachmentCard({
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
      mediaType="text/markdown"
      sizeBytes={size_bytes}
      collapsible
      onContextMenu={onContextMenu}
    >
      {error ? (
        <div className={styles.error}>Failed to load: {error}</div>
      ) : text === null ? (
        <div className={styles.error}>Loading…</div>
      ) : (
        <div className={styles.markdownBody}>
          <MessageMarkdown content={text} />
        </div>
      )}
    </AttachmentCardShell>
  );
}
