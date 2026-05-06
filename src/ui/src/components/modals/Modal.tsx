import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./Modal.module.css";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * Use a wider card (640px, capped at 92vw) instead of the default 420px.
   * For modals showing lists, multi-column content, or anything that needs
   * to breathe horizontally — e.g. the keyboard shortcuts viewer.
   */
  wide?: boolean;
  /**
   * Move overflow scroll from the card to the body. Combined with the card
   * becoming a flex column, this keeps the title in view while the body
   * content scrolls — useful when the modal contains a long list with a
   * search box that should stay sticky at the top.
   *
   * Without this, the entire card scrolls (default), which is fine for
   * short confirmation dialogs but loses the title once the user scrolls.
   */
  bodyScroll?: boolean;
}

let nextModalId = 1;
const modalStack: number[] = [];

function topmostModalId(): number | null {
  return modalStack[modalStack.length - 1] ?? null;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  bodyScroll,
}: ModalProps) {
  const titleId = useId();
  const modalId = useRef<number | null>(null);
  if (modalId.current === null) modalId.current = nextModalId++;
  const cardClass = [
    styles.card,
    wide && styles.cardWide,
    bodyScroll && styles.cardScrollable,
  ]
    .filter(Boolean)
    .join(" ");
  const bodyClass = [styles.body, bodyScroll && styles.bodyScrollable]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    const id = modalId.current;
    if (id === null) return;
    modalStack.push(id);
    return () => {
      const idx = modalStack.lastIndexOf(id);
      if (idx >= 0) modalStack.splice(idx, 1);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (topmostModalId() !== modalId.current) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClose();
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const modal = (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={cardClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h3 id={titleId} className={styles.title}>
            {title}
          </h3>
        </div>
        <div className={bodyClass}>{children}</div>
      </div>
    </div>
  );

  return typeof document === "undefined"
    ? modal
    : createPortal(modal, document.body);
}
