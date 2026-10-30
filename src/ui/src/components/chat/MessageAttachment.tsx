import type { ChatAttachment } from "../../types/chat";
import type { DownloadableAttachment } from "../../utils/attachmentDownload";
import { CsvAttachmentCard } from "./CsvAttachmentCard";
import { JsonAttachmentCard } from "./JsonAttachmentCard";
import { MarkdownAttachmentCard } from "./MarkdownAttachmentCard";
import { TextAttachmentCard } from "./TextAttachmentCard";
import type { TextDataAttachmentProps } from "./TextDataAttachmentCard";

interface MessageAttachmentTextHandlers {
  /** Right-click handler for the card body. Wires the same Download / Copy /
   *  Open menu image attachments use. */
  onContextMenu?: (
    e: React.MouseEvent,
    attachment: DownloadableAttachment,
    attachmentId?: string,
  ) => void;
}

/** Look up the attachment's media type and render the right card. Image and
 *  PDF rendering live in `ChatMessageBubble` (`MessageAttachmentGallery`)
 *  because they hook into the lightbox / PDF-thumbnail machinery; this
 *  component owns the text/data cards. Returns `null` for any media type not
 *  in `TEXT_DATA_CARDS` — there is no implicit fallback to the plain-text
 *  card. */
export function MessageAttachment({
  attachment,
  handlers,
}: {
  attachment: ChatAttachment;
  handlers: MessageAttachmentTextHandlers;
}): React.ReactElement | null {
  const downloadable: DownloadableAttachment = {
    filename: attachment.filename,
    media_type: attachment.media_type,
    data_base64: attachment.data_base64,
  };
  const onContextMenu = (e: React.MouseEvent) =>
    handlers.onContextMenu?.(e, downloadable, attachment.id);

  const Card = TEXT_DATA_CARDS[attachment.media_type];
  if (!Card) return null;
  return (
    <Card
      attachmentId={attachment.id}
      text_content={attachment.text_content}
      data_base64={attachment.data_base64}
      filename={attachment.filename}
      size_bytes={attachment.size_bytes}
      onContextMenu={onContextMenu}
    />
  );
}

/** Text-data media type → inline preview card. `isTextDataMediaType` must
 *  stay in lock-step with these keys. */
const TEXT_DATA_CARDS: Record<
  string,
  ((props: TextDataAttachmentProps) => React.ReactElement) | undefined
> = {
  "text/csv": CsvAttachmentCard,
  "text/markdown": MarkdownAttachmentCard,
  "application/json": JsonAttachmentCard,
  "text/plain": TextAttachmentCard,
};

/** Whether the given media type is rendered by `<MessageAttachment>`. The
 *  caller should defer non-matching types to its own image / PDF branches. */
export function isTextDataMediaType(mediaType: string): boolean {
  return TEXT_DATA_CARDS[mediaType] !== undefined;
}
