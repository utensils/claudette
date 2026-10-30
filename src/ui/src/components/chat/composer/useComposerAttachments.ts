import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../../stores/useAppStore";
import { readFileAsBase64 } from "../../../services/tauri";
import type { PendingAttachment, StoredAttachment } from "../../../types/chat";
import { base64ToBytes } from "../../../utils/base64";
import {
  MAX_ATTACHMENTS,
  SUPPORTED_ATTACHMENT_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_IMAGE_TYPES,
  isTextFile,
  maxSizeFor,
} from "../../../utils/attachmentValidation";

/** Rebuild a `PendingAttachment[]` for a session from the slice's
 * `StoredAttachment[]`. Image preview blob URLs are regenerated from
 * `data_base64` (the underlying Blob is GC'd once the previous mount
 * dropped its reference). PDFs and non-image attachments don't get a
 * thumbnail re-generated here — that work is asynchronous and gated
 * inside `addAttachment`; on rehydration we leave `preview_url` empty
 * for those, so the row still renders the filename + size with no
 * thumbnail rather than blocking the mount on PDF.js. */
export function hydratePendingFromSlice(sessionId: string): PendingAttachment[] {
  const stored = useAppStore.getState().pendingAttachmentsBySession[sessionId];
  if (!stored || stored.length === 0) return [];
  return stored.map((a) => ({
    id: a.id,
    filename: a.filename,
    media_type: a.media_type,
    data_base64: a.data_base64,
    preview_url: rehydrateImagePreviewUrl(a),
    size_bytes: a.size_bytes,
    text_content: a.text_content,
  }));
}

function rehydrateImagePreviewUrl(a: StoredAttachment): string {
  if (!SUPPORTED_IMAGE_TYPES.has(a.media_type)) return "";
  try {
    const bytes = base64ToBytes(a.data_base64);
    const blob = new Blob([bytes], { type: a.media_type });
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error("[chat-input] failed to rehydrate preview URL", e);
    return "";
  }
}

/** Convert a File/Blob to a base64 string (without the data: prefix). */
function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Composer attachment state: local pending list (with transient blob URLs)
 * mirrored to the per-session store slice, plus add/remove, clipboard paste,
 * Tauri-native + HTML5 drag-drop, file dialog, and rollback prefill.
 */
export function useComposerAttachments({
  sessionId,
  isRemote,
}: {
  sessionId: string;
  isRemote: boolean;
}) {
  // `pendingAttachments` is the local view (with transient blob URLs);
  // the slice (`pendingAttachmentsBySession`) is the per-session source
  // of truth so attachments survive any composer remount — including
  // the unmount that fires when `<ChatPanel>` is conditionally rendered
  // out of `AppLayout` whenever the user opens a file or diff. The
  // unmount cleanup further down revokes blob URLs on tear-down so we
  // don't leak them; the next mount calls `hydratePendingFromSlice` to
  // recreate the URLs from the persisted `data_base64` payload.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>(
    () => hydratePendingFromSlice(sessionId),
  );
  // Track current attachments in a ref so the unmount cleanup always
  // revokes the latest blob URLs (not the stale initial-render snapshot).
  const pendingAttachmentsRef = useRef(pendingAttachments);
  pendingAttachmentsRef.current = pendingAttachments;
  const setPendingAttachmentsBoth = useCallback(
    (
      sessionForUpdate: string,
      updater: (prev: PendingAttachment[]) => PendingAttachment[],
    ) => {
      const next = updater(pendingAttachmentsRef.current);
      pendingAttachmentsRef.current = next;
      setPendingAttachments(next);
      // Mirror to slice (without `preview_url` since it's transient). Keep
      // this outside the React state updater; calling a Zustand setter from
      // inside the updater trips React's render-time update warning.
      const stored: StoredAttachment[] = next.map((a) => ({
        id: a.id,
        filename: a.filename,
        media_type: a.media_type,
        data_base64: a.data_base64,
        size_bytes: a.size_bytes,
        text_content: a.text_content,
      }));
      useAppStore
        .getState()
        .setPendingAttachmentsForSession(sessionForUpdate, stored);
    },
    [],
  );
  const [dragActive, setDragActive] = useState(false);

  const addAttachment = useCallback(async (file: Blob, filename: string, textContent?: string) => {
    if (isRemote) return; // Attachments not supported over remote transport
    if (!SUPPORTED_ATTACHMENT_TYPES.has(file.type)) {
      console.warn(`Unsupported file type: ${file.type}`);
      return;
    }
    const isPdf = SUPPORTED_DOCUMENT_TYPES.has(file.type);
    const isImage = SUPPORTED_IMAGE_TYPES.has(file.type);
    const isText = isTextFile(file.type);
    const prepared = isImage
      ? await import("../../../utils/imageAttachment").then((m) =>
          m.prepareImageAttachment(file, filename),
        )
      : { blob: file, mediaType: file.type, filename };
    const attachmentBlob = prepared.blob;
    const mediaType = prepared.mediaType;
    const sizeLimit = maxSizeFor(mediaType);
    if (attachmentBlob.size > sizeLimit) {
      console.warn(
        `File too large: ${(attachmentBlob.size / 1024 / 1024).toFixed(1)} MB (max ${(sizeLimit / 1024 / 1024).toFixed(1)} MB)`,
      );
      return;
    }
    const data_base64 = await fileToBase64(attachmentBlob);
    let preview_url: string;
    if (isPdf) {
      const { generatePdfThumbnail } = await import("../../../utils/pdfThumbnail");
      preview_url = await generatePdfThumbnail(await attachmentBlob.arrayBuffer()).catch(() => "");
      if (!preview_url) return;
    } else if (isImage) {
      preview_url = URL.createObjectURL(attachmentBlob);
    } else {
      preview_url = "";
    }
    const att: PendingAttachment = {
      id: crypto.randomUUID(),
      filename: prepared.filename,
      media_type: mediaType,
      data_base64,
      preview_url,
      size_bytes: attachmentBlob.size,
      text_content: isText ? (textContent ?? await attachmentBlob.text()) : null,
    };
    setPendingAttachmentsBoth(sessionId, (prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        if (preview_url.startsWith("blob:")) URL.revokeObjectURL(preview_url);
        return prev;
      }
      return [...prev, att];
    });
  }, [isRemote, sessionId, setPendingAttachmentsBoth]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachmentsBoth(sessionId, (prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.preview_url.startsWith("blob:")) URL.revokeObjectURL(att.preview_url);
      return prev.filter((a) => a.id !== id);
    });
  }, [sessionId, setPendingAttachmentsBoth]);

  useEffect(() => {
    return () => {
      for (const a of pendingAttachmentsRef.current) {
        if (a.preview_url.startsWith("blob:")) URL.revokeObjectURL(a.preview_url);
      }
    };
  }, []);

  // Consume attachment prefill (e.g. from rollback) — convert the raw
  // base64 data back into PendingAttachment objects with preview URLs.
  const attachmentsPrefill = useAppStore((s) => s.pendingAttachmentsPrefill);
  const setAttachmentsPrefill = useAppStore((s) => s.setPendingAttachmentsPrefill);
  useEffect(() => {
    if (!attachmentsPrefill || attachmentsPrefill.length === 0) return;
    setAttachmentsPrefill(null);

    (async () => {
      for (const a of attachmentsPrefill) {
        const bytes = base64ToBytes(a.data_base64);
        const blob = new Blob([bytes], { type: a.media_type });
        await addAttachment(blob, a.filename, a.text_content ?? undefined);
      }
    })().catch((e) => console.error("Failed to restore attachment prefill:", e));
  }, [attachmentsPrefill, setAttachmentsPrefill, addAttachment]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        // Skip text/plain — pasting text should insert into the textarea,
        // not create a file attachment.
        if (item.type === "text/plain") continue;
        // Some clipboard writers (notably `navigator.clipboard.write` with
        // a ClipboardItem) expose the image both as a "string" item (its
        // data URL) and a "file" item. We must check the file variant —
        // getAsFile() returns null for string items, which would
        // silently drop the paste.
        if (item.kind !== "file") continue;
        if (SUPPORTED_ATTACHMENT_TYPES.has(item.type)) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const defaultName = item.type === "application/pdf"
              ? "pasted-document.pdf"
              : "pasted-image.png";
            addAttachment(file, file.name || defaultName);
          }
          return; // Only handle first attachment
        }
      }
      // If no supported items, let the default text paste proceed.
    },
    [addAttachment],
  );

  // Tauri intercepts native file drops before they reach the webview's HTML5
  // drag events. Use Tauri's onDragDropEvent to handle file drops, and fall
  // through to readFileAsBase64 (which validates type + size on the Rust side).
  //
  // The handler references addAttachment via a ref to avoid re-registering the
  // listener when the callback identity changes — re-registration causes a race
  // where the old listener's async cleanup hasn't fired yet and the same drop
  // event is processed by both the old and new listeners, duplicating files.
  const addAttachmentRef = useRef(addAttachment);
  addAttachmentRef.current = addAttachment;
  const tauriDragListenerActive = useRef(false);

  useEffect(() => {
    if (isRemote) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (cancelled) return;
      return getCurrentWebview()
        .onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragActive(true);
          } else if (event.payload.type === "leave") {
            setDragActive(false);
          } else if (event.payload.type === "drop") {
            setDragActive(false);
            for (const filePath of event.payload.paths) {
              readFileAsBase64(filePath)
                .then((result) => {
                  if (cancelled) return;
                  const bytes = base64ToBytes(result.data_base64);
                  const blob = new Blob([bytes], { type: result.media_type });
                  addAttachmentRef.current(blob, result.filename, result.text_content ?? undefined);
                })
                .catch((err) =>
                  console.warn("Skipped dropped file:", err),
                );
            }
          }
        })
        .then((fn) => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
            tauriDragListenerActive.current = true;
          }
        });
    }).catch((err) => {
      console.error(
        "[drag-drop] Tauri native listener failed, falling back to HTML5:",
        err,
      );
      tauriDragListenerActive.current = false;
      setDragActive(false);
    });

    return () => {
      cancelled = true;
      tauriDragListenerActive.current = false;
      unlisten?.();
    };
  }, [isRemote]);

  // HTML5 file-drop fallback: activates only when the Tauri native handler
  // failed to register (tauriDragListenerActive is false). The global dragover
  // preventDefault is always active to suppress the browser's default
  // file-navigation behavior.
  useEffect(() => {
    if (isRemote) return;

    const preventNav = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDragEnter = (e: DragEvent) => {
      if (tauriDragListenerActive.current) return;
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragActive(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      if (tauriDragListenerActive.current) return;
      if (e.relatedTarget) return;
      setDragActive(false);
    };

    const handleDrop = (e: DragEvent) => {
      if (tauriDragListenerActive.current) return;
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const files = e.dataTransfer.files;
      if (files.length === 0) return;
      for (const file of Array.from(files)) {
        void addAttachmentRef.current(file, file.name).catch((error) => {
          console.error("[drag-drop] Failed to add dropped attachment:", error);
        });
      }
    };

    document.addEventListener("dragover", preventNav);
    document.addEventListener("dragenter", handleDragEnter);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("drop", handleDrop);

    return () => {
      document.removeEventListener("dragover", preventNav);
      document.removeEventListener("dragenter", handleDragEnter);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("drop", handleDrop);
    };
  }, [isRemote]);

  const handleAttachClick = useCallback(async () => {
    const selected = await open({ multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      try {
        const result = await readFileAsBase64(filePath);
        const bytes = base64ToBytes(result.data_base64);
        const blob = new Blob([bytes], { type: result.media_type });
        await addAttachment(blob, result.filename, result.text_content ?? undefined);
      } catch (err) {
        console.error("Failed to read file:", err);
      }
    }
  }, [addAttachment]);

  return {
    pendingAttachments,
    setPendingAttachments,
    pendingAttachmentsRef,
    setPendingAttachmentsBoth,
    dragActive,
    removeAttachment,
    handlePaste,
    handleAttachClick,
  };
}
