/**
 * Render the first page of a PDF to a PNG data URL thumbnail.
 *
 * pdfjs-dist is loaded lazily via dynamic import so the ~600 KB library
 * is code-split into its own chunk and only fetched when a user first
 * attaches a PDF.
 *
 * Results are cached by a caller-supplied key so repeated renders of the
 * same PDF (e.g. re-renders of chat history) return instantly.
 */

let workerInitialized = false;

const cache = new Map<string, string>();

export async function generatePdfThumbnail(
  data: ArrayBuffer,
  maxSize = 128,
  cacheKey?: string,
): Promise<string> {
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) return cached;
  }

  const pdfjsLib = await import("pdfjs-dist");
  if (!workerInitialized) {
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url"))
      .default;
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
    workerInitialized = true;
  }

  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(1);

  const viewport = page.getViewport({ scale: 1 });
  const scale = maxSize / Math.max(viewport.width, viewport.height);
  const scaled = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = scaled.width;
  canvas.height = scaled.height;
  const ctx = canvas.getContext("2d")!;

  await page.render({ canvas, canvasContext: ctx, viewport: scaled }).promise;
  const dataUrl = canvas.toDataURL("image/png");

  // Release the pixel buffer immediately.
  canvas.width = 0;
  canvas.height = 0;

  await pdf.destroy();

  if (cacheKey) {
    cache.set(cacheKey, dataUrl);
  }

  return dataUrl;
}
