/**
 * Pick a human-readable noun for an attachment's media type. Used to label
 * the context menu actions so a PDF doesn't show "Download Image". See
 * issue 430.
 */
export function attachmentNounFor(mediaType: string): "Image" | "PDF" | "File" {
  if (mediaType.startsWith("image/")) return "Image";
  if (mediaType === "application/pdf") return "PDF";
  return "File";
}

/**
 * Build the labels for the standard attachment context menu items, picking
 * a noun that matches the media type. The menu *items* (with their handlers)
 * are still assembled at the call site so each handler closes over the
 * caller's helpers — this just produces the strings.
 */
export function buildAttachmentMenuLabels(mediaType: string): {
  download: string;
  copy: string;
  open: string;
} {
  const noun = attachmentNounFor(mediaType);
  return {
    download: `Download ${noun}`,
    copy: `Copy ${noun}`,
    // "New Window" is media-agnostic — the OS opens whichever app handles
    // the type. Keeping a single label avoids drift across platforms.
    open: "Open in New Window",
  };
}
