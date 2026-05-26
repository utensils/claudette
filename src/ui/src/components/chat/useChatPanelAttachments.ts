import { useCallback, useMemo, useState } from "react";
import type { MouseEvent } from "react";

import { loadAttachmentData } from "../../services/tauri";
import {
  isShareSupported,
  type DownloadableAttachment,
} from "../../utils/attachmentDownload";

export type AttachmentMenuState = {
  x: number;
  y: number;
  attachment: DownloadableAttachment;
  /** Persisted PDFs hydrate without data_base64 (it's stripped to keep the
   *  initial IPC small). Hold the row id so menu actions can lazy-load bytes. */
  attachmentId?: string;
} | null;

export type AttachmentLightboxState = {
  attachment: DownloadableAttachment;
  returnFocus: HTMLElement | null;
} | null;

export function useChatPanelAttachments() {
  const [attachmentMenu, setAttachmentMenu] =
    useState<AttachmentMenuState>(null);
  const [lightbox, setLightbox] = useState<AttachmentLightboxState>(null);

  const openAttachmentMenu = useCallback(
    (
      e: MouseEvent,
      attachment: DownloadableAttachment,
      attachmentId?: string,
    ) => {
      e.preventDefault();
      setAttachmentMenu({
        x: e.clientX,
        y: e.clientY,
        attachment,
        attachmentId,
      });
    },
    [],
  );

  const ensureAttachmentBytes = useCallback(
    async (
      attachment: DownloadableAttachment,
      attachmentId?: string,
    ): Promise<DownloadableAttachment> => {
      if (attachment.data_base64 || !attachmentId) return attachment;
      const data_base64 = await loadAttachmentData(attachmentId);
      return { ...attachment, data_base64 };
    },
    [],
  );

  const openLightbox = useCallback(
    (e: MouseEvent, attachment: DownloadableAttachment) => {
      setLightbox({
        attachment,
        returnFocus: (e.currentTarget as HTMLElement) ?? null,
      });
    },
    [],
  );

  // navigator.canShare({ files: [probe] }) doesn't change across re-renders.
  const shareSupported = useMemo(() => isShareSupported(), []);

  return {
    attachmentMenu,
    ensureAttachmentBytes,
    lightbox,
    openAttachmentMenu,
    openLightbox,
    setAttachmentMenu,
    setLightbox,
    shareSupported,
  };
}
