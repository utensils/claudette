/** Supported image MIME types for attachments. */
export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Supported document MIME types. */
export const SUPPORTED_DOCUMENT_TYPES = new Set(["application/pdf"]);

/** Supported text file MIME types. */
export const SUPPORTED_TEXT_TYPES = new Set(["text/plain"]);

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

/** Max raw file size for a text file attachment (500 KB). */
export const MAX_TEXT_SIZE = 500 * 1024;

/** Max number of attachments per message. */
export const MAX_ATTACHMENTS = 5;

/** Get the size limit for a given MIME type. */
export function maxSizeFor(mimeType: string): number {
  if (SUPPORTED_DOCUMENT_TYPES.has(mimeType)) return MAX_PDF_SIZE;
  if (SUPPORTED_TEXT_TYPES.has(mimeType)) return MAX_TEXT_SIZE;
  return MAX_IMAGE_SIZE;
}

/** Whether a MIME type represents a text file attachment. */
export function isTextFile(mimeType: string): boolean {
  return SUPPORTED_TEXT_TYPES.has(mimeType);
}
