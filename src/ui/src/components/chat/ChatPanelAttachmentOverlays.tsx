import type { Dispatch, MouseEvent, SetStateAction } from "react";

import {
  copyAttachmentToClipboard,
  downloadAttachment,
  openAttachmentInBrowser,
  openAttachmentWithDefaultApp,
  shareAttachment,
  type DownloadableAttachment,
} from "../../utils/attachmentDownload";
import { AttachmentContextMenu } from "./AttachmentContextMenu";
import { AttachmentLightbox } from "./AttachmentLightbox";
import { buildAttachmentMenuLabels } from "./attachmentContextMenuLabels";
import type {
  AttachmentLightboxState,
  AttachmentMenuState,
} from "./useChatPanelAttachments";

type ChatPanelAttachmentOverlaysProps = {
  attachmentMenu: AttachmentMenuState;
  browseAvailable: boolean;
  ensureAttachmentBytes: (
    attachment: DownloadableAttachment,
    attachmentId?: string,
  ) => Promise<DownloadableAttachment>;
  lightbox: AttachmentLightboxState;
  openAttachmentMenu: (
    e: MouseEvent,
    attachment: DownloadableAttachment,
    attachmentId?: string,
  ) => void;
  setAttachmentMenu: Dispatch<SetStateAction<AttachmentMenuState>>;
  setLightbox: Dispatch<SetStateAction<AttachmentLightboxState>>;
  shareSupported: boolean;
};

export function ChatPanelAttachmentOverlays({
  attachmentMenu,
  browseAvailable,
  ensureAttachmentBytes,
  lightbox,
  openAttachmentMenu,
  setAttachmentMenu,
  setLightbox,
  shareSupported,
}: ChatPanelAttachmentOverlaysProps) {
  return (
    <>
      {attachmentMenu && (() => {
        const mt = attachmentMenu.attachment.media_type;
        const labels = buildAttachmentMenuLabels(mt);
        const isImage = mt.startsWith("image/");
        const withBytes = () =>
          ensureAttachmentBytes(
            attachmentMenu.attachment,
            attachmentMenu.attachmentId,
          );
        return (
          <AttachmentContextMenu
            x={attachmentMenu.x}
            y={attachmentMenu.y}
            onClose={() => setAttachmentMenu(null)}
            items={[
              ...(browseAvailable
                ? [
                    {
                      label: labels.download,
                      onSelect: () => {
                        withBytes()
                          .then(downloadAttachment)
                          .catch((err) => console.error("Download failed:", err));
                      },
                    },
                  ]
                : []),
              {
                label: labels.copy,
                onSelect: () => {
                  withBytes()
                    .then(copyAttachmentToClipboard)
                    .catch((err) => console.error("Copy failed:", err));
                },
              },
              ...(isImage
                ? [
                    {
                      label: labels.open,
                      onSelect: () => {
                        withBytes()
                          .then(openAttachmentInBrowser)
                          .catch((err) =>
                            console.error("Open in browser failed:", err),
                          );
                      },
                    },
                  ]
                : [
                    {
                      label: "Open with default app",
                      onSelect: () => {
                        withBytes()
                          .then(openAttachmentWithDefaultApp)
                          .catch((err) =>
                            console.error("Open with default app failed:", err),
                          );
                      },
                    },
                  ]),
              ...(shareSupported
                ? [
                    {
                      label: "Share…",
                      onSelect: () => {
                        withBytes()
                          .then(shareAttachment)
                          .catch((err) => console.error("Share failed:", err));
                      },
                    },
                  ]
                : []),
            ]}
          />
        );
      })()}
      {lightbox && (
        <AttachmentLightbox
          attachment={lightbox.attachment}
          returnFocusTo={lightbox.returnFocus}
          onClose={() => setLightbox(null)}
          onContextMenu={(e) => openAttachmentMenu(e, lightbox.attachment)}
        />
      )}
    </>
  );
}
