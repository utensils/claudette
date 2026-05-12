// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_SIZE } from "./attachmentValidation";
import { prepareImageAttachment } from "./imageAttachment";

const originalCreateElement = document.createElement.bind(document);

describe("prepareImageAttachment", () => {
  let createImageBitmapMock: ReturnType<typeof vi.fn>;
  let drawImage: ReturnType<typeof vi.fn>;
  let toBlobResult: Blob | null;

  beforeEach(() => {
    drawImage = vi.fn();
    toBlobResult = new Blob([new Uint8Array(32)], { type: "image/jpeg" });
    createImageBitmapMock = vi.fn().mockResolvedValue({
      width: 4000,
      height: 3000,
      close: vi.fn(),
    });
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      if (tagName !== "canvas") return originalCreateElement(tagName);

      const canvas = originalCreateElement("canvas") as HTMLCanvasElement;
      vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
      vi.spyOn(canvas, "toBlob").mockImplementation((callback: BlobCallback) => callback(toBlobResult));
      return canvas;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes through unsupported image formats", async () => {
    const file = new Blob([new Uint8Array(MAX_IMAGE_SIZE + 1)], { type: "image/gif" });

    const result = await prepareImageAttachment(file, "animation.gif");

    expect(result).toEqual({ blob: file, mediaType: "image/gif", filename: "animation.gif" });
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("passes through supported images that are already small enough", async () => {
    const file = new Blob([new Uint8Array(128)], { type: "image/png" });

    const result = await prepareImageAttachment(file, "small.png");

    expect(result).toEqual({ blob: file, mediaType: "image/png", filename: "small.png" });
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it("resizes oversized raster images to JPEG and updates the filename", async () => {
    const file = new Blob([new Uint8Array(MAX_IMAGE_SIZE + 1)], { type: "image/png" });

    const result = await prepareImageAttachment(file, "screenshot.png");

    expect(createImageBitmapMock).toHaveBeenCalledWith(file);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(result.blob).toBe(toBlobResult);
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.filename).toBe("screenshot.jpg");
  });

  it("falls back to the original image when canvas encoding fails", async () => {
    const file = new Blob([new Uint8Array(MAX_IMAGE_SIZE + 1)], { type: "image/webp" });
    toBlobResult = null;

    const result = await prepareImageAttachment(file, "large.webp");

    expect(result).toEqual({ blob: file, mediaType: "image/webp", filename: "large.webp" });
  });

  it("falls back to the original image when re-encoding is not smaller", async () => {
    const file = new Blob([new Uint8Array(MAX_IMAGE_SIZE + 1)], { type: "image/jpeg" });
    toBlobResult = new Blob([new Uint8Array(MAX_IMAGE_SIZE + 2)], { type: "image/jpeg" });

    const result = await prepareImageAttachment(file, "photo.jpeg");

    expect(result).toEqual({ blob: file, mediaType: "image/jpeg", filename: "photo.jpeg" });
  });
});
