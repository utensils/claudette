/** Supported image MIME types for attachments. */
export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/** Supported document MIME types. */
export const SUPPORTED_DOCUMENT_TYPES = new Set(["application/pdf"]);

/** Supported text/data MIME types. Each renders with a type-specific preview
 *  card on the message-list side. Adding a type here also requires adding it
 *  to `MessageAttachment.tsx` (both the `switch` and `isTextDataMediaType`)
 *  or it won't render — there is no implicit fallback to the plain-text
 *  card. Mirrors `TEXT_TYPE_RULES` in
 *  `src/agent_mcp/tools/send_to_user.rs`. */
export const SUPPORTED_TEXT_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
]);

/** All supported attachment MIME types (images + documents + text). */
export const SUPPORTED_ATTACHMENT_TYPES = new Set([
  ...SUPPORTED_IMAGE_TYPES,
  ...SUPPORTED_DOCUMENT_TYPES,
  ...SUPPORTED_TEXT_TYPES,
]);

/** Max raw file size for an image attachment (3.75 MB -> ~5 MB base64). */
export const MAX_IMAGE_SIZE = 3.75 * 1024 * 1024;

/** Max raw file size for a PDF attachment (20 MB — Anthropic API limit). */
export const MAX_PDF_SIZE = 20 * 1024 * 1024;

/** Max raw file size for a plain-text attachment (1 MB). */
export const MAX_TEXT_SIZE = 1024 * 1024;

/** Max raw file size for a CSV attachment (2 MB — wider rows than prose). */
export const MAX_CSV_SIZE = 2 * 1024 * 1024;

/** Max raw file size for a Markdown attachment (1 MB). */
export const MAX_MARKDOWN_SIZE = 1024 * 1024;

/** Max raw file size for a JSON attachment (1 MB). */
export const MAX_JSON_SIZE = 1024 * 1024;

/** Max number of attachments per message. */
export const MAX_ATTACHMENTS = 5;

/** Get the size limit for a given MIME type. */
export function maxSizeFor(mimeType: string): number {
  if (SUPPORTED_DOCUMENT_TYPES.has(mimeType)) return MAX_PDF_SIZE;
  switch (mimeType) {
    case "text/csv":
      return MAX_CSV_SIZE;
    case "text/markdown":
      return MAX_MARKDOWN_SIZE;
    case "application/json":
      return MAX_JSON_SIZE;
    case "text/plain":
      return MAX_TEXT_SIZE;
    default:
      return MAX_IMAGE_SIZE;
  }
}

/** Whether a MIME type represents a text file attachment. */
export function isTextFile(mimeType: string): boolean {
  return SUPPORTED_TEXT_TYPES.has(mimeType);
}
