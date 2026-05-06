import { describe, it, expect, vi, beforeAll } from "vitest";

// vitest runs in Node; ClipboardItem is a browser global. Stub a minimal
// constructor that records its input so the tests can assert on the data
// the real browser/webview would see.
beforeAll(() => {
  if (typeof (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem === "undefined") {
    class FakeClipboardItem {
      readonly types: string[];
      readonly data: Record<string, Blob>;
      constructor(data: Record<string, Blob>) {
        this.data = data;
        this.types = Object.keys(data);
      }
    }
    (globalThis as unknown as { ClipboardItem: typeof FakeClipboardItem }).ClipboardItem =
      FakeClipboardItem;
  }
});
import {
  extensionFor,
  downloadAttachment,
  openAttachmentInBrowser,
  openAttachmentWithDefaultApp,
  copyAttachmentFileToClipboard,
  copyAttachmentToClipboard,
  shareAttachment,
  isShareSupported,
  type DownloadableAttachment,
} from "./attachmentDownload";

const fixture: DownloadableAttachment = {
  filename: "screenshot.png",
  media_type: "image/png",
  data_base64: "aGVsbG8=", // "hello"
};

describe("extensionFor", () => {
  it("derives from media_type", () => {
    expect(extensionFor(fixture)).toBe("png");
  });

  it("strips +xml / +json suffixes", () => {
    expect(
      extensionFor({ ...fixture, media_type: "image/svg+xml" }),
    ).toBe("svg");
  });

  it("falls back to filename extension when media_type is opaque", () => {
    expect(
      extensionFor({
        ...fixture,
        filename: "doc.pdf",
        media_type: "application/x-something totally weird",
      }),
    ).toBe("pdf");
  });

  it("falls back to bin as last resort", () => {
    expect(
      extensionFor({
        filename: "noextension",
        media_type: "application/x has a space",
        data_base64: "",
      }),
    ).toBe("bin");
  });
});

describe("downloadAttachment", () => {
  it("returns null and skips invoke when user cancels the dialog", async () => {
    const save = vi.fn().mockResolvedValue(null);
    const invoke = vi.fn();

    const result = await downloadAttachment(fixture, {
      save,
      invoke,
    });

    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toMatchObject({
      defaultPath: "screenshot.png",
      filters: [{ name: "image/png", extensions: ["png"] }],
    });
  });

  it("writes bytes to the chosen path and returns it", async () => {
    const save = vi.fn().mockResolvedValue("/tmp/out.png");
    const invoke = vi.fn().mockResolvedValue(undefined);

    const result = await downloadAttachment(fixture, {
      save,
      invoke,
    });

    expect(result).toBe("/tmp/out.png");
    expect(invoke).toHaveBeenCalledWith("save_attachment_bytes", {
      path: "/tmp/out.png",
      bytes: [104, 101, 108, 108, 111], // "hello"
    });
  });

  it("propagates errors from invoke (e.g. disk full)", async () => {
    const save = vi.fn().mockResolvedValue("/tmp/out.png");
    const invoke = vi.fn().mockRejectedValue(new Error("ENOSPC"));

    await expect(
      downloadAttachment(fixture, { save, invoke }),
    ).rejects.toThrow("ENOSPC");
  });
});

describe("openAttachmentInBrowser", () => {
  it("invokes the backend with decoded bytes, filename, and mediaType", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);

    await openAttachmentInBrowser(fixture, { invoke });

    expect(invoke).toHaveBeenCalledWith("open_attachment_in_browser", {
      bytes: [104, 101, 108, 108, 111],
      filename: "screenshot.png",
      mediaType: "image/png",
    });
  });
});

describe("openAttachmentWithDefaultApp", () => {
  // The HTML-wrapper path renders bytes inside <img>, which produces a
  // broken page for PDFs (and anything else that isn't an image). This
  // helper stages the bytes to a real file and lets the OS route to the
  // appropriate viewer (Preview, Adobe, etc).
  it("invokes open_attachment_with_default_app with decoded bytes", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const pdf: DownloadableAttachment = {
      filename: "doc.pdf",
      media_type: "application/pdf",
      data_base64: "JVBERi0=", // %PDF-
    };
    await openAttachmentWithDefaultApp(pdf, { invoke });
    expect(invoke).toHaveBeenCalledWith("open_attachment_with_default_app", {
      bytes: [37, 80, 68, 70, 45],
      filename: "doc.pdf",
      mediaType: "application/pdf",
    });
  });
});

describe("copyAttachmentFileToClipboard", () => {
  it("invokes copy_attachment_file_to_clipboard with decoded bytes", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const pdf: DownloadableAttachment = {
      filename: "doc.pdf",
      media_type: "application/pdf",
      data_base64: "JVBERi0=", // %PDF-
    };

    await copyAttachmentFileToClipboard(pdf, { invoke });

    expect(invoke).toHaveBeenCalledWith("copy_attachment_file_to_clipboard", {
      bytes: [37, 80, 68, 70, 45],
      filename: "doc.pdf",
      mediaType: "application/pdf",
    });
  });
});

describe("copyAttachmentToClipboard", () => {
  it("writes a ClipboardItem via navigator.clipboard.write", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    await copyAttachmentToClipboard(fixture, {
      clipboard: { write } as unknown as Clipboard,
    });
    expect(write).toHaveBeenCalledOnce();
    const items = write.mock.calls[0][0] as ClipboardItem[];
    expect(items).toHaveLength(1);
    expect(items[0].types).toContain("image/png");
  });

  it("throws when the clipboard API is unavailable", async () => {
    await expect(
      copyAttachmentToClipboard(fixture, { clipboard: undefined }),
    ).rejects.toThrow(/not available/);
  });

  it("propagates errors from clipboard.write", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(
      copyAttachmentToClipboard(fixture, {
        clipboard: { write } as unknown as Clipboard,
      }),
    ).rejects.toThrow("denied");
  });

  it("routes PDF attachments through the backend file clipboard command", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const invoke = vi.fn().mockResolvedValue(undefined);
    const pdfFixture: DownloadableAttachment = {
      filename: "doc.pdf",
      data_base64: "JVBERi0=", // %PDF-
      media_type: "application/pdf",
    };

    await copyAttachmentToClipboard(pdfFixture, {
      clipboard: { write } as unknown as Clipboard,
      invoke,
    });

    expect(invoke).toHaveBeenCalledWith("copy_attachment_file_to_clipboard", {
      bytes: [37, 80, 68, 70, 45],
      filename: "doc.pdf",
      mediaType: "application/pdf",
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("writes CSV attachments as text via the injected writeText", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const csvFixture: DownloadableAttachment = {
      filename: "people.csv",
      data_base64: "aWQsbmFtZQoxLEFkYQo=", // base64 of 'id,name\n1,Ada\n'
      media_type: "text/csv",
    };

    await copyAttachmentToClipboard(csvFixture, {
      clipboard: { write } as unknown as Clipboard,
      writeText,
    });

    expect(writeText).toHaveBeenCalledWith("id,name\n1,Ada\n");
    expect(write).not.toHaveBeenCalled();
  });

  it("writes JSON attachments as text via the injected writeText", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const jsonFixture: DownloadableAttachment = {
      filename: "data.json",
      data_base64: "eyJvayI6dHJ1ZX0=", // base64 of '{"ok":true}'
      media_type: "application/json",
    };

    await copyAttachmentToClipboard(jsonFixture, {
      clipboard: { write } as unknown as Clipboard,
      writeText,
    });

    expect(writeText).toHaveBeenCalledWith('{"ok":true}');
    expect(write).not.toHaveBeenCalled();
  });

  // WebKit silently drops image/svg+xml ClipboardItems, so a copied SVG
  // would never reach the system clipboard. Production routes SVGs
  // through Tauri's writeText, which bypasses the WKWebView allowlist.
  it("writes SVG attachments via the injected writeText (Tauri clipboard)", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const svgFixture: DownloadableAttachment = {
      filename: "drawing.svg",
      data_base64: "PHN2Zy8+", // base64 of '<svg/>'
      media_type: "image/svg+xml",
    };
    await copyAttachmentToClipboard(svgFixture, {
      clipboard: { write } as unknown as Clipboard,
      writeText,
    });
    expect(writeText).toHaveBeenCalledWith("<svg/>");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("isShareSupported", () => {
  it("returns false when navigator has no share()", () => {
    expect(isShareSupported({}, null)).toBe(false);
  });

  it("returns true when share exists and canShare is missing", () => {
    expect(isShareSupported({ share: async () => {} }, null)).toBe(true);
  });

  it("asks canShare about a probe file when both exist", () => {
    const canShare = vi.fn().mockReturnValue(true);
    const probe = new File([new Uint8Array(0)], "x.png", { type: "image/png" });
    expect(isShareSupported({ share: async () => {}, canShare }, probe)).toBe(
      true,
    );
    expect(canShare).toHaveBeenCalledWith({ files: [probe] });
  });

  it("denies when canShare returns false for the probe", () => {
    const probe = new File([new Uint8Array(0)], "x.png", { type: "image/png" });
    expect(
      isShareSupported(
        { share: async () => {}, canShare: () => false },
        probe,
      ),
    ).toBe(false);
  });
});

describe("shareAttachment", () => {
  it("calls navigator.share with a file and a title", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    await shareAttachment(fixture, { nav: { share } });

    expect(share).toHaveBeenCalledOnce();
    const arg = share.mock.calls[0][0];
    expect(arg.title).toBe("screenshot.png");
    expect(arg.files).toHaveLength(1);
    expect((arg.files[0] as File).name).toBe("screenshot.png");
    expect((arg.files[0] as File).type).toBe("image/png");
  });

  it("swallows AbortError (user dismissed the sheet)", async () => {
    const share = vi
      .fn()
      .mockRejectedValue(new DOMException("user cancelled", "AbortError"));
    await expect(
      shareAttachment(fixture, { nav: { share } }),
    ).resolves.toBeUndefined();
  });

  it("surfaces non-Abort errors", async () => {
    const share = vi.fn().mockRejectedValue(new Error("share backend down"));
    await expect(
      shareAttachment(fixture, { nav: { share } }),
    ).rejects.toThrow("share backend down");
  });

  it("throws when navigator.share is unavailable", async () => {
    await expect(shareAttachment(fixture, { nav: {} })).rejects.toThrow(
      /not available/,
    );
  });
});
