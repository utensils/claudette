import {
  TextDataAttachmentCard,
  type TextDataAttachmentProps,
} from "./TextDataAttachmentCard";
import styles from "./MessageAttachment.module.css";

/** Inline preview for a plain-text attachment: monospace block in a
 *  collapsible card. Replaces the prior 1-line "FileText + filename + size"
 *  badge so logs and other text artifacts get an actual preview rather than
 *  a download chip. */
export function TextAttachmentCard(props: TextDataAttachmentProps) {
  return (
    <TextDataAttachmentCard
      {...props}
      mediaType="text/plain"
      collapsible
      render={(text) => <pre className={styles.preBody}>{text}</pre>}
    />
  );
}
