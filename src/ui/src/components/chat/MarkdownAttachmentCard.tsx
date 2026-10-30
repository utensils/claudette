import { MessageMarkdown } from "./MessageMarkdown";
import {
  TextDataAttachmentCard,
  type TextDataAttachmentProps,
} from "./TextDataAttachmentCard";
import styles from "./MessageAttachment.module.css";

/** Inline preview for a Markdown attachment: rendered through the same
 *  pipeline used for assistant messages so headings, lists, code blocks
 *  match the chat surface. Body collapses past ~320px. */
export function MarkdownAttachmentCard(props: TextDataAttachmentProps) {
  return (
    <TextDataAttachmentCard
      {...props}
      mediaType="text/markdown"
      collapsible
      render={(text) => (
        <div className={styles.markdownBody}>
          <MessageMarkdown content={text} />
        </div>
      )}
    />
  );
}
