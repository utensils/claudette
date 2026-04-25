import { describe, it, expect } from "vitest";
import {
  attachmentNounFor,
  buildAttachmentMenuLabels,
  clampMenuToViewport,
} from "./AttachmentContextMenu";

// The component itself is thin wiring around a few DOM listeners and a
// portal; its integration is verified manually in the running app. The
// clamp logic is pure and carries the interesting edge-case behavior, so
// we unit-test it in isolation — following the existing convention in
// focusTargets.test.ts of pure-logic-only tests rather than pulling in a
// DOM harness (jsdom / testing-library).
//
// The async "stay open while the action is in flight" behavior
// (AttachmentContextMenuItem.onSelect returning a Promise holds the menu
// open until it settles) is intentionally verified manually rather than
// with a jsdom render harness: copy a large image and paste into another
// app before the menu dismisses — the paste works because the menu only
// closes after the clipboard write has actually resolved.

describe("clampMenuToViewport", () => {
  it("passes through positions that already fit", () => {
    expect(clampMenuToViewport(100, 100, 220, 80, 1200, 800)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("pulls the menu left when the click is near the right edge", () => {
    const { x } = clampMenuToViewport(1190, 100, 220, 80, 1200, 800);
    // maxX = 1200 - 220 - 8 = 972
    expect(x).toBe(972);
  });

  it("pulls the menu up when the click is near the bottom edge", () => {
    const { y } = clampMenuToViewport(100, 790, 220, 80, 1200, 800);
    // maxY = 800 - 80 - 8 = 712
    expect(y).toBe(712);
  });

  it("enforces a minimum margin on the top-left corner", () => {
    expect(clampMenuToViewport(-10, -10, 220, 80, 1200, 800)).toEqual({
      x: 8,
      y: 8,
    });
  });

  it("honors a custom margin", () => {
    const { x } = clampMenuToViewport(5, 100, 220, 80, 1200, 800, 16);
    expect(x).toBe(16);
  });
});

describe("attachmentNounFor", () => {
  // The default-image labels read awkwardly for PDFs and text files
  // ("Download Image" for a PDF). Map media types to a sensible noun so
  // the menu labels match the artifact kind. See issue 430.

  it("returns 'Image' for raster image types", () => {
    expect(attachmentNounFor("image/png")).toBe("Image");
    expect(attachmentNounFor("image/jpeg")).toBe("Image");
    expect(attachmentNounFor("image/gif")).toBe("Image");
    expect(attachmentNounFor("image/webp")).toBe("Image");
    expect(attachmentNounFor("image/svg+xml")).toBe("Image");
  });

  it("returns 'PDF' for application/pdf", () => {
    expect(attachmentNounFor("application/pdf")).toBe("PDF");
  });

  it("returns 'File' for text/plain", () => {
    expect(attachmentNounFor("text/plain")).toBe("File");
  });

  it("falls back to 'File' for anything else", () => {
    expect(attachmentNounFor("application/octet-stream")).toBe("File");
    expect(attachmentNounFor("")).toBe("File");
  });
});

describe("buildAttachmentMenuLabels", () => {
  it("uses 'Image' verbs for image attachments", () => {
    expect(buildAttachmentMenuLabels("image/png")).toEqual({
      download: "Download Image",
      copy: "Copy Image",
      open: "Open in New Window",
    });
  });

  it("uses 'PDF' verbs for PDFs", () => {
    expect(buildAttachmentMenuLabels("application/pdf")).toEqual({
      download: "Download PDF",
      copy: "Copy PDF",
      open: "Open in New Window",
    });
  });

  it("uses 'File' verbs for text/plain", () => {
    expect(buildAttachmentMenuLabels("text/plain")).toEqual({
      download: "Download File",
      copy: "Copy File",
      open: "Open in New Window",
    });
  });
});
