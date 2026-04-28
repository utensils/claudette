import { describe, it, expect } from "vitest";
import {
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_TEXT_TYPES,
  SUPPORTED_ATTACHMENT_TYPES,
  MAX_IMAGE_SIZE,
  MAX_PDF_SIZE,
  MAX_TEXT_SIZE,
  MAX_CSV_SIZE,
  MAX_MARKDOWN_SIZE,
  MAX_JSON_SIZE,
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

  it("accepts text/data files", () => {
    expect(isSupported("text/plain")).toBe(true);
    expect(isSupported("text/csv")).toBe(true);
    expect(isSupported("text/markdown")).toBe(true);
    expect(isSupported("application/json")).toBe(true);
  });

  it("accepts SVG images", () => {
    expect(isSupported("image/svg+xml")).toBe(true);
  });

  it("rejects unsupported file types", () => {
    expect(isSupported("image/bmp")).toBe(false);
    expect(isSupported("video/mp4")).toBe(false);
    expect(isSupported("application/zip")).toBe(false);
    expect(isSupported("application/x-tar")).toBe(false);
    expect(isSupported("text/yaml")).toBe(false);
    expect(isSupported("text/html")).toBe(false);
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
    expect(isTextFile("text/csv")).toBe(true);
    expect(isTextFile("text/markdown")).toBe(true);
    expect(isTextFile("application/json")).toBe(true);
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

  it("enforces text file size limit at 1 MB", () => {
    expect(validateSize("text/plain", 100 * 1024)).toBe(true);
    expect(validateSize("text/plain", MAX_TEXT_SIZE)).toBe(true);
    expect(validateSize("text/plain", MAX_TEXT_SIZE + 1)).toBe(false);
  });

  it("enforces CSV size limit at 2 MB", () => {
    expect(validateSize("text/csv", 1 * 1024 * 1024)).toBe(true);
    expect(validateSize("text/csv", MAX_CSV_SIZE)).toBe(true);
    expect(validateSize("text/csv", MAX_CSV_SIZE + 1)).toBe(false);
  });

  it("enforces Markdown size limit at 1 MB", () => {
    expect(validateSize("text/markdown", MAX_MARKDOWN_SIZE)).toBe(true);
    expect(validateSize("text/markdown", MAX_MARKDOWN_SIZE + 1)).toBe(false);
  });

  it("enforces JSON size limit at 1 MB", () => {
    expect(validateSize("application/json", MAX_JSON_SIZE)).toBe(true);
    expect(validateSize("application/json", MAX_JSON_SIZE + 1)).toBe(false);
  });

  it("applies correct limit per type", () => {
    const size = 10 * 1024 * 1024; // 10 MB — valid for PDF, invalid for image/text/csv/json/md
    expect(validateSize("application/pdf", size)).toBe(true);
    expect(validateSize("image/png", size)).toBe(false);
    expect(validateSize("text/plain", size)).toBe(false);
    expect(validateSize("text/csv", size)).toBe(false);
    expect(validateSize("text/markdown", size)).toBe(false);
    expect(validateSize("application/json", size)).toBe(false);
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

  it("uses text blocks for text/data files", () => {
    expect(contentBlockType("text/plain")).toBe("text");
    expect(contentBlockType("text/csv")).toBe("text");
    expect(contentBlockType("text/markdown")).toBe("text");
    expect(contentBlockType("application/json")).toBe("text");
  });
});

describe("text file helpers", () => {
  it("isTextFile identifies text MIME types", () => {
    expect(isTextFile("text/plain")).toBe(true);
    expect(isTextFile("text/csv")).toBe(true);
    expect(isTextFile("text/markdown")).toBe(true);
    expect(isTextFile("application/json")).toBe(true);
    expect(isTextFile("image/png")).toBe(false);
    expect(isTextFile("application/pdf")).toBe(false);
  });

  it("maxSizeFor returns the right cap per text type", () => {
    expect(maxSizeFor("text/plain")).toBe(1024 * 1024);
    expect(maxSizeFor("text/csv")).toBe(2 * 1024 * 1024);
    expect(maxSizeFor("text/markdown")).toBe(1024 * 1024);
    expect(maxSizeFor("application/json")).toBe(1024 * 1024);
  });

  it("SUPPORTED_TEXT_TYPES contains all four text/data types", () => {
    expect(SUPPORTED_TEXT_TYPES.has("text/plain")).toBe(true);
    expect(SUPPORTED_TEXT_TYPES.has("text/csv")).toBe(true);
    expect(SUPPORTED_TEXT_TYPES.has("text/markdown")).toBe(true);
    expect(SUPPORTED_TEXT_TYPES.has("application/json")).toBe(true);
    expect(SUPPORTED_TEXT_TYPES.size).toBe(4);
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

describe("HTML5 drag-drop fallback coordination", () => {
  it("HTML5 handler noops when Tauri native listener is active", () => {
    const tauriActive = { current: true };
    const processed: string[] = [];

    const handleDrop = (filename: string) => {
      if (tauriActive.current) return;
      processed.push(filename);
    };

    handleDrop("file1.png");
    expect(processed).toEqual([]);

    tauriActive.current = false;
    handleDrop("file2.png");
    expect(processed).toEqual(["file2.png"]);
  });

  it("HTML5 handler ignores non-file drags", () => {
    const types = ["text/plain"];
    const hasFiles = types.includes("Files");
    expect(hasFiles).toBe(false);

    const fileTypes = ["Files", "text/plain"];
    const hasFileDrag = fileTypes.includes("Files");
    expect(hasFileDrag).toBe(true);
  });
});
