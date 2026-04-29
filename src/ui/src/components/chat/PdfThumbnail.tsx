import React, { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { loadAttachmentData } from "../../services/tauri";
import { base64ToBytes } from "../../utils/base64";
import styles from "./ChatPanel.module.css";

/**
 * Lazily renders a PDF first-page thumbnail.
 *
 * Accepts either `dataBase64` (optimistic/pre-loaded data) or `attachmentId`
 * (fetches the body from the backend on demand). Shows a loading pill with
 * the filename while the thumbnail generates.
 */
export function PdfThumbnail({
  dataBase64,
  attachmentId,
  filename,
  className,
  onClick,
  onContextMenu,
}: {
  dataBase64?: string;
  attachmentId?: string;
  filename: string;
  className?: string;
  /** Left-click handler. Used to open the PDF with the system's default
   *  PDF viewer rather than the lightbox (which only renders images). */
  onClick?: () => void;
  /** Right-click handler. Wired so PDF thumbnails get the same Claudette
   *  context menu (Download / Copy / Open) as image attachments rather than
   *  WebKit's default image menu. See issue 430. */
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;

    (async () => {
      let b64 = dataBase64;
      // If no inline data, fetch on demand from the backend.
      if (!b64 && attachmentId) {
        b64 = await loadAttachmentData(attachmentId);
      }
      if (!b64 || cancelled) return;
      const bytes = base64ToBytes(b64);
      const { generatePdfThumbnail } = await import("../../utils/pdfThumbnail");
      const url = await generatePdfThumbnail(bytes.buffer as ArrayBuffer, 300, attachmentId);
      if (!cancelled) setSrc(url);
    })().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [dataBase64, attachmentId]);

  // Both the loading-state pill and the rendered first-page thumbnail
  // need to be keyboard-actionable when an onClick is wired — without
  // role/tabIndex/Enter+Space handling, non-mouse users can't open the
  // PDF.
  const interactiveProps = onClick
    ? {
        role: "button" as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        },
        "aria-label": `Open ${filename}`,
      }
    : {};
  if (!src) {
    return (
      <div
        className={styles.messagePdf}
        onClick={onClick}
        onContextMenu={onContextMenu}
        {...interactiveProps}
      >
        <FileText size={16} />
        <span>{filename}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={filename}
      className={className}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={onClick ? { cursor: "zoom-in" } : undefined}
      {...interactiveProps}
    />
  );
}
