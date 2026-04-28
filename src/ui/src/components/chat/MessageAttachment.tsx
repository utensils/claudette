import type { ChatAttachment } from "../../types/chat";
import type { DownloadableAttachment } from "../../utils/attachmentDownload";
import { CsvAttachmentCard } from "./CsvAttachmentCard";
import { JsonAttachmentCard } from "./JsonAttachmentCard";
import { MarkdownAttachmentCard } from "./MarkdownAttachmentCard";
import { TextAttachmentCard } from "./TextAttachmentCard";

interface MessageAttachmentTextHandlers {
  /** Right-click handler for the card body. Wires the same Download / Copy /
   *  Open menu image attachments use. */
  onContextMenu?: (
    e: React.MouseEvent,
    attachment: DownloadableAttachment,
    attachmentId?: string,
  ) => void;
}

/** Switch over the attachment's media type and render the right card. Image
 *  and PDF rendering still live in `ChatPanel.tsx` because they hook into the
 *  lightbox / PDF-thumbnail machinery; this component owns the text/data
 *  cards. Returns `null` for any media type that isn't in the explicit
 *  switch — there is no implicit fallback to the plain-text card. To add a
 *  new text/data type, also add a case here AND extend
 *  `isTextDataMediaType` so `ChatPanel` routes it to this component. */
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

  switch (attachment.media_type) {
    case "text/csv":
      return (
        <CsvAttachmentCard
          attachmentId={attachment.id}
          text_content={attachment.text_content}
          data_base64={attachment.data_base64}
          filename={attachment.filename}
          size_bytes={attachment.size_bytes}
          onContextMenu={onContextMenu}
        />
      );
    case "text/markdown":
      return (
        <MarkdownAttachmentCard
          attachmentId={attachment.id}
          text_content={attachment.text_content}
          data_base64={attachment.data_base64}
          filename={attachment.filename}
          size_bytes={attachment.size_bytes}
          onContextMenu={onContextMenu}
        />
      );
    case "application/json":
      return (
        <JsonAttachmentCard
          attachmentId={attachment.id}
          text_content={attachment.text_content}
          data_base64={attachment.data_base64}
          filename={attachment.filename}
          size_bytes={attachment.size_bytes}
          onContextMenu={onContextMenu}
        />
      );
    case "text/plain":
      return (
        <TextAttachmentCard
          attachmentId={attachment.id}
          text_content={attachment.text_content}
          data_base64={attachment.data_base64}
          filename={attachment.filename}
          size_bytes={attachment.size_bytes}
          onContextMenu={onContextMenu}
        />
      );
    default:
      return null;
  }
}

/** Whether the given media type is rendered by `<MessageAttachment>`. The
 *  caller should defer non-matching types to its own image / PDF branches.
 *  Keep in lock-step with the `switch` above: every case in the switch must
 *  have a corresponding entry here, and vice-versa. */
export function isTextDataMediaType(mediaType: string): boolean {
  return (
    mediaType === "text/csv" ||
    mediaType === "text/markdown" ||
    mediaType === "application/json" ||
    mediaType === "text/plain"
  );
}
