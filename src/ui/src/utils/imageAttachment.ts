export interface PreparedImageAttachment {
  blob: Blob;
  mediaType: string;
}

const MAX_LONG_EDGE = 2000;
const TARGET_IMAGE_BYTES = 3.75 * 1024 * 1024;
const JPEG_QUALITY = 0.82;
const RESIZABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function prepareImageAttachment(file: Blob): Promise<PreparedImageAttachment> {
  if (!RESIZABLE_IMAGE_TYPES.has(file.type) || file.size <= TARGET_IMAGE_BYTES) {
    return { blob: file, mediaType: file.type };
  }

  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return { blob: file, mediaType: file.type };

      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
      canvas.width = 0;
      canvas.height = 0;

      if (!blob || blob.size >= file.size) {
        return { blob: file, mediaType: file.type };
      }
      return { blob, mediaType: blob.type || "image/jpeg" };
    } finally {
      bitmap.close();
    }
  } catch {
    return { blob: file, mediaType: file.type };
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
