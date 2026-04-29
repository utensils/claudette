import { save } from "@tauri-apps/plugin-dialog";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";

import { base64ToBytes } from "./base64";

/**
 * Minimal shape an attachment needs to expose for Download / Open In Browser.
 * Accepts either the persisted `ChatAttachment` (data_base64) or the staged
 * `PendingAttachment` (same field name) — both carry base64 bytes.
 */
export interface DownloadableAttachment {
  filename: string;
  media_type: string;
  data_base64: string;
}

/**
 * `image/png` → `png`. Falls back to the current filename's extension, then to
 * `bin`. Keeps the save dialog's filter name accurate for uncommon types.
 */
export function extensionFor(attachment: DownloadableAttachment): string {
  const fromMedia = attachment.media_type.split("/").pop();
  if (fromMedia && /^[a-z0-9+.-]+$/i.test(fromMedia)) {
    return fromMedia.replace("+xml", "").replace("+json", "");
  }
  const dot = attachment.filename.lastIndexOf(".");
  if (dot > 0 && dot < attachment.filename.length - 1) {
    return attachment.filename.slice(dot + 1);
  }
  return "bin";
}

/**
 * Prompt the user with a native save dialog, then write the attachment bytes
 * to the chosen path. Returns the saved path on success, or `null` if the
 * user cancelled the dialog.
 *
 * `saveImpl` and `invokeImpl` are injectable so unit tests don't need to hit
 * the real Tauri IPC; production code uses the module-level Tauri bindings.
 */
export async function downloadAttachment(
  attachment: DownloadableAttachment,
  deps: {
    save?: typeof save;
    invoke?: typeof invoke;
  } = {},
): Promise<string | null> {
  const saveFn = deps.save ?? save;
  const invokeFn = deps.invoke ?? invoke;

  const ext = extensionFor(attachment);
  const path = await saveFn({
    defaultPath: attachment.filename,
    filters: [
      {
        name: attachment.media_type || "File",
        extensions: [ext],
      },
    ],
  });

  if (!path) {
    return null;
  }

  const bytes = base64ToBytes(attachment.data_base64);
  await invokeFn("save_attachment_bytes", {
    path,
    bytes: Array.from(bytes),
  });
  return path;
}

/**
 * Write the attachment to a temp HTML wrapper and open it with the system
 * default handler (routes to the user's browser because the wrapper is .html).
 * Resolves once the open command has been dispatched; the backend is
 * fire-and-forget after that.
 */
export async function openAttachmentInBrowser(
  attachment: DownloadableAttachment,
  deps: { invoke?: typeof invoke } = {},
): Promise<void> {
  const invokeFn = deps.invoke ?? invoke;
  const bytes = base64ToBytes(attachment.data_base64);
  await invokeFn("open_attachment_in_browser", {
    bytes: Array.from(bytes),
    filename: attachment.filename,
    mediaType: attachment.media_type,
  });
}

/**
 * Stage the attachment to a temp file with its natural extension and open
 * it with the system default handler (e.g. PDFs → Preview on macOS,
 * whichever PDF reader is registered on Linux/Windows). The HTML-wrapper
 * path used by `openAttachmentInBrowser` only renders inside `<img>`, so
 * it produces a broken page for PDFs — this command is the right path
 * for non-image previewing.
 */
export async function openAttachmentWithDefaultApp(
  attachment: DownloadableAttachment,
  deps: { invoke?: typeof invoke } = {},
): Promise<void> {
  const invokeFn = deps.invoke ?? invoke;
  const bytes = base64ToBytes(attachment.data_base64);
  await invokeFn("open_attachment_with_default_app", {
    bytes: Array.from(bytes),
    filename: attachment.filename,
    mediaType: attachment.media_type,
  });
}

/**
 * Copy the attachment image to the system clipboard using the native
 * `navigator.clipboard.write()` API. Zero IPC, zero base64→number[]
 * serialization, zero Rust round-trip — the webview writes directly to
 * the OS clipboard the same way any browser's "Copy Image" does.
 *
 * SVG is special-cased: WebKit's ClipboardItem implementation silently
 * drops `image/svg+xml`, so a copied SVG would never reach the system
 * clipboard. Since SVG is XML, write it as `text/plain` (the markup
 * itself) — that survives the round-trip and pastes correctly into any
 * text editor, into GitHub comments, and back into Claudette's composer.
 */
export async function copyAttachmentToClipboard(
  attachment: DownloadableAttachment,
  deps: {
    clipboard?: Clipboard;
    /** Injectable text-clipboard writer — bypasses the W3C clipboard
     *  permission gate. Production wires this to Tauri's plugin so SVGs
     *  reach the system clipboard reliably. Defaults to the Tauri plugin
     *  in browser/webview contexts; tests pass a stub. */
    writeText?: (text: string) => Promise<void>;
  } = {},
): Promise<void> {
  const clipboard =
    deps.clipboard ??
    (typeof navigator === "undefined" ? undefined : navigator.clipboard);
  const bytes = base64ToBytes(attachment.data_base64);
  if (attachment.media_type === "image/svg+xml") {
    // WKWebView silently drops `image/svg+xml` ClipboardItems, so writing
    // an SVG via navigator.clipboard.write succeeds but the system
    // clipboard receives nothing. Since SVG is XML, route through the
    // Tauri clipboard plugin's writeText, which bypasses the webview's
    // ClipboardItem allowlist entirely. Falls back to the W3C path only
    // when neither a writeText injection nor a window context is
    // available (i.e. tests with a stubbed clipboard).
    const text = new TextDecoder("utf-8").decode(bytes);
    if (deps.writeText) {
      await deps.writeText(text);
      return;
    }
    if (typeof window !== "undefined") {
      await clipboardWriteText(text);
      return;
    }
    if (!clipboard) {
      throw new Error("Clipboard API not available");
    }
    const blob = new Blob([text], { type: "text/plain" });
    await clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    return;
  }
  // Non-SVG path uses the W3C ClipboardItem API directly — this is the
  // only branch that requires `navigator.clipboard.write`.
  if (!clipboard) {
    throw new Error("Clipboard API not available");
  }
  const blob = new Blob([bytes], { type: attachment.media_type });
  await clipboard.write([
    new ClipboardItem({ [attachment.media_type]: blob }),
  ]);
}

/**
 * Probe whether the current webview can invoke the native share sheet with
 * a file. On macOS WKWebView the Web Share API is available; on Linux /
 * Windows WebView2 it typically isn't, and we hide the Share menu item
 * rather than offering a broken action.
 *
 * `nav` is injectable so the unit tests can exercise all three branches
 * (no navigator.share, has navigator.share but no canShare, fully capable)
 * deterministically — the real `navigator` is captured once at page load.
 */
export function isShareSupported(
  nav: {
    share?: (data: ShareData) => Promise<void>;
    canShare?: (data: ShareData) => boolean;
  } = typeof navigator === "undefined" ? {} : navigator,
  probeFile: File | null = typeof File === "undefined"
    ? null
    : new File([new Uint8Array(0)], "probe.png", { type: "image/png" }),
): boolean {
  if (typeof nav.share !== "function") return false;
  // canShare is advisory on some browsers. Assume yes if it's missing, since
  // nav.share existing is a strong signal. Only deny when canShare
  // explicitly returns false for our probe file.
  if (typeof nav.canShare === "function" && probeFile) {
    return nav.canShare({ files: [probeFile] });
  }
  return true;
}

/**
 * Invoke the native share sheet with the attachment as a single file.
 * Resolves when the sheet closes (success, cancel, or the user just
 * dismissing). Throws only if the API itself is unavailable — the
 * caller is expected to gate on `isShareSupported()` first.
 */
export async function shareAttachment(
  attachment: DownloadableAttachment,
  deps: {
    nav?: { share?: (data: ShareData) => Promise<void> };
  } = {},
): Promise<void> {
  const nav =
    deps.nav ?? (typeof navigator === "undefined" ? {} : navigator);
  if (typeof nav.share !== "function") {
    throw new Error("Web Share API not available in this environment");
  }
  const bytes = base64ToBytes(attachment.data_base64);
  // Share wants a File; construct it from the in-memory bytes. If the
  // webview doesn't expose File (node test env without polyfills), let
  // the caller's try/catch surface the error.
  const file = new File([bytes], attachment.filename, {
    type: attachment.media_type,
  });
  try {
    await nav.share({
      files: [file],
      title: attachment.filename,
    });
  } catch (e) {
    // AbortError = user dismissed the sheet; not a real failure.
    if (e instanceof DOMException && e.name === "AbortError") return;
    throw e;
  }
}
