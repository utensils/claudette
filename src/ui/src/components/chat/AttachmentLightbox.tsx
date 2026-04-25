import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import type { DownloadableAttachment } from "../../utils/attachmentDownload";
import styles from "./AttachmentLightbox.module.css";

interface AttachmentLightboxProps {
  attachment: DownloadableAttachment;
  /** Element to return focus to on close — typically the originating <img>. */
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
  /** Right-click handler for the previewed image. When set, suppresses the
   *  WebKit default image context menu (Open in New Window, Copy Image, …)
   *  and lets the caller surface its own attachment menu. See issue 433. */
  onContextMenu?: (e: React.MouseEvent) => void;
}

/**
 * Pure two-target focus-trap decision: given the active element and a Tab
 * keypress, return which of the two targets should receive focus next, or
 * `null` if the native tab order already cycles correctly.
 *
 * Exported for unit tests — keeps the component body focused on wiring.
 */
export function nextFocusTarget(
  active: Element | null,
  shift: boolean,
  close: HTMLElement,
  wrap: HTMLElement,
): HTMLElement | null {
  if (shift) {
    // Shift+Tab: wrap → close, close → wrap (cycle backward).
    if (active === wrap) return close;
    if (active === close) return wrap;
    return close;
  }
  // Tab: close → wrap, wrap → close (cycle forward).
  if (active === close) return wrap;
  if (active === wrap) return close;
  return close;
}

/**
 * Pure: should a mousedown on the overlay dismiss the lightbox? Yes iff the
 * click lands on the backdrop element itself, not on a descendant.
 */
export function isBackdropDismiss(
  target: EventTarget | null,
  backdrop: HTMLElement | null,
): boolean {
  return target !== null && target === backdrop;
}

/**
 * Pure: does this attachment need the SVG fallback minimum size in the
 * lightbox? SVGs that only declare a viewBox (no width/height on the root
 * <svg>) collapse to 0×0 when loaded through <img>, because the data URL
 * sandbox doesn't expose intrinsic dimensions. Force a floor for those.
 *
 * Raster types always carry intrinsic pixel dimensions, so they don't need
 * the fallback — applying it would also blow up tiny pixel-art images.
 */
export function needsSvgFallbackSize(mediaType: string): boolean {
  return mediaType === "image/svg+xml";
}

export function AttachmentLightbox({
  attachment,
  returnFocusTo,
  onClose,
  onContextMenu,
}: AttachmentLightboxProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const imageWrapRef = useRef<HTMLDivElement>(null);

  // Focus the close button on open, restore to the trigger on close.
  useEffect(() => {
    const previouslyFocused = returnFocusTo ?? null;
    closeBtnRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [returnFocusTo]);

  // Escape + Tab trap. Capture phase so we swallow Escape before any
  // underlying context-menu handler also bound at capture.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "Tab") {
        const close = closeBtnRef.current;
        const wrap = imageWrapRef.current;
        if (!close || !wrap) return;
        const target = nextFocusTarget(
          document.activeElement,
          e.shiftKey,
          close,
          wrap,
        );
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Prevent background scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function onBackdropMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (isBackdropDismiss(e.target, backdropRef.current)) onClose();
  }

  const src = `data:${attachment.media_type};base64,${attachment.data_base64}`;

  const overlay = (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename}
      onMouseDown={onBackdropMouseDown}
      data-testid="attachment-lightbox"
    >
      <button
        ref={closeBtnRef}
        type="button"
        className={styles.closeBtn}
        aria-label="Close image preview"
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <div ref={imageWrapRef} className={styles.imageWrap} tabIndex={0}>
        <img
          src={src}
          alt={attachment.filename}
          className={
            needsSvgFallbackSize(attachment.media_type)
              ? `${styles.image} ${styles.imageSvg}`
              : styles.image
          }
          draggable={false}
          onContextMenu={onContextMenu}
        />
      </div>
      <div className={styles.caption}>{attachment.filename}</div>
    </div>
  );

  return typeof document === "undefined"
    ? overlay
    : createPortal(overlay, document.body);
}
