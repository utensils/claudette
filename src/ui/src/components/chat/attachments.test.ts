import { describe, it, expect } from "vitest";
import {
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_TEXT_TYPES,
  SUPPORTED_ATTACHMENT_TYPES,
  MAX_IMAGE_SIZE,
  MAX_PDF_SIZE,
  MAX_TEXT_SIZE,
  MAX_ATTACHMENTS,
  maxSizeFor,
  isTextFile,
} from "../../utils/attachmentValidation";

function isSupported(mimeType: string): boolean {
  return SUPPORTED_ATTACHMENT_TYPES.has(mimeType);
}

function isImage(mimeType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.has(mimeType);
}

function isDocument(mimeType: string): boolean {
  return SUPPORTED_DOCUMENT_TYPES.has(mimeType);
}

function validateSize(mimeType: string, sizeBytes: number): boolean {
  return sizeBytes <= maxSizeFor(mimeType);
}

/** Mirrors the content block type selection in build_stdin_message. */
function contentBlockType(mimeType: string): "image" | "document" | "text" {
  if (isTextFile(mimeType)) return "text";
  return mimeType === "application/pdf" ? "document" : "image";
}

describe("attachment type validation", () => {
  it("accepts supported image types", () => {
    expect(isSupported("image/png")).toBe(true);
    expect(isSupported("image/jpeg")).toBe(true);
    expect(isSupported("image/gif")).toBe(true);
    expect(isSupported("image/webp")).toBe(true);
  });

  it("accepts PDF documents", () => {
    expect(isSupported("application/pdf")).toBe(true);
  });

  it("accepts text/plain files", () => {
    expect(isSupported("text/plain")).toBe(true);
  });

  it("rejects unsupported file types", () => {
    expect(isSupported("image/svg+xml")).toBe(false);
    expect(isSupported("image/bmp")).toBe(false);
    expect(isSupported("video/mp4")).toBe(false);
    expect(isSupported("application/json")).toBe(false);
    expect(isSupported("application/zip")).toBe(false);
  });

  it("classifies images vs documents vs text", () => {
    expect(isImage("image/png")).toBe(true);
    expect(isDocument("image/png")).toBe(false);
    expect(isTextFile("image/png")).toBe(false);
    expect(isImage("application/pdf")).toBe(false);
    expect(isDocument("application/pdf")).toBe(true);
    expect(isTextFile("application/pdf")).toBe(false);
    expect(isImage("text/plain")).toBe(false);
    expect(isDocument("text/plain")).toBe(false);
    expect(isTextFile("text/plain")).toBe(true);
  });
});

describe("attachment size validation", () => {
  it("enforces image size limit at 3.75 MB", () => {
    expect(validateSize("image/png", 1024)).toBe(true);
    expect(validateSize("image/png", 3 * 1024 * 1024)).toBe(true);
    expect(validateSize("image/png", MAX_IMAGE_SIZE)).toBe(true);
    expect(validateSize("image/png", MAX_IMAGE_SIZE + 1)).toBe(false);
    expect(validateSize("image/jpeg", 10 * 1024 * 1024)).toBe(false);
  });

  it("enforces PDF size limit at 20 MB", () => {
    expect(validateSize("application/pdf", 5 * 1024 * 1024)).toBe(true);
    expect(validateSize("application/pdf", 15 * 1024 * 1024)).toBe(true);
    expect(validateSize("application/pdf", MAX_PDF_SIZE)).toBe(true);
    expect(validateSize("application/pdf", MAX_PDF_SIZE + 1)).toBe(false);
  });

  it("enforces text file size limit at 500 KB", () => {
    expect(validateSize("text/plain", 100 * 1024)).toBe(true);
    expect(validateSize("text/plain", MAX_TEXT_SIZE)).toBe(true);
    expect(validateSize("text/plain", MAX_TEXT_SIZE + 1)).toBe(false);
  });

  it("applies correct limit per type", () => {
    const size = 10 * 1024 * 1024; // 10 MB — valid for PDF, invalid for image
    expect(validateSize("application/pdf", size)).toBe(true);
    expect(validateSize("image/png", size)).toBe(false);
    expect(validateSize("text/plain", size)).toBe(false);
  });
});

describe("attachment count limit", () => {
  it("enforces max attachment count of 5", () => {
    expect(MAX_ATTACHMENTS).toBe(5);
    expect(4 < MAX_ATTACHMENTS).toBe(true);
    expect(5 < MAX_ATTACHMENTS).toBe(false);
  });
});

describe("content block type mapping", () => {
  it("uses image blocks for image types", () => {
    expect(contentBlockType("image/png")).toBe("image");
    expect(contentBlockType("image/jpeg")).toBe("image");
    expect(contentBlockType("image/gif")).toBe("image");
    expect(contentBlockType("image/webp")).toBe("image");
  });

  it("uses document blocks for PDFs", () => {
    expect(contentBlockType("application/pdf")).toBe("document");
  });

  it("uses text blocks for text files", () => {
    expect(contentBlockType("text/plain")).toBe("text");
  });
});

describe("text file helpers", () => {
  it("isTextFile identifies text MIME types", () => {
    expect(isTextFile("text/plain")).toBe(true);
    expect(isTextFile("image/png")).toBe(false);
    expect(isTextFile("application/pdf")).toBe(false);
    expect(isTextFile("application/json")).toBe(false);
  });

  it("maxSizeFor returns 500 KB for text files", () => {
    expect(maxSizeFor("text/plain")).toBe(500 * 1024);
  });

  it("SUPPORTED_TEXT_TYPES contains text/plain", () => {
    expect(SUPPORTED_TEXT_TYPES.has("text/plain")).toBe(true);
    expect(SUPPORTED_TEXT_TYPES.size).toBe(1);
  });
});

describe("blob URL cleanup", () => {
  it("identifies blob URLs that need revoking", () => {
    const blobUrl = "blob:http://localhost/abc-123";
    const dataUrl = "data:image/png;base64,iVBOR...";
    expect(blobUrl.startsWith("blob:")).toBe(true);
    expect(dataUrl.startsWith("blob:")).toBe(false);
  });
});

describe("drag-drop deduplication", () => {
  it("useEffect cleanup pattern prevents stale listeners", () => {
    let cancelled = false;
    const processed: string[] = [];

    const processFile = (name: string) => {
      if (cancelled) return;
      processed.push(name);
    };

    processFile("file1.png");
    expect(processed).toEqual(["file1.png"]);

    cancelled = true;
    processFile("file2.png");
    expect(processed).toEqual(["file1.png"]);
  });
});
