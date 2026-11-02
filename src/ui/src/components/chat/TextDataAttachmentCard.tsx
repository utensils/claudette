import type { ReactNode } from "react";
import { AttachmentCardShell } from "./AttachmentCardShell";
import { useAttachmentText } from "./useAttachmentText";
import styles from "./MessageAttachment.module.css";

/** Props every text-data attachment card (text / markdown / JSON / CSV)
 *  takes — the persisted attachment fields plus a context-menu handler. */
export interface TextDataAttachmentProps {
  attachmentId?: string;
  text_content?: string | null;
  data_base64?: string | null;
  filename: string;
  size_bytes: number;
  onContextMenu?: (e: React.MouseEvent) => void;
}

/**
 * Shared body for text-data attachment cards: loads the text (inline
 * `text_content`, base64, or lazily by id), shows the loading / error
 * states, and hands the loaded text to `render` inside the card shell.
 * Each concrete card only decides how its text is presented.
 */
export function TextDataAttachmentCard({
  mediaType,
  collapsible,
  render,
  attachmentId,
  text_content,
  data_base64,
  filename,
  size_bytes,
  onContextMenu,
}: TextDataAttachmentProps & {
  mediaType: string;
  collapsible: boolean;
  render: (text: string) => ReactNode;
}) {
  const { text, error } = useAttachmentText({
    text_content,
    data_base64,
    attachmentId,
  });

  return (
    <AttachmentCardShell
      filename={filename}
      mediaType={mediaType}
      sizeBytes={size_bytes}
      collapsible={collapsible}
      onContextMenu={onContextMenu}
    >
      {error ? (
        <div className={styles.error}>Failed to load: {error}</div>
      ) : text === null ? (
        <div className={styles.error}>Loading…</div>
      ) : (
        render(text)
      )}
    </AttachmentCardShell>
  );
}
