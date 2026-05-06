import type { ReactNode } from "react";
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

export function Modal({
  title,
  onClose,
  children,
  wide,
  bodyScroll,
}: ModalProps) {
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
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={cardClass} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
        </div>
        <div className={bodyClass}>{children}</div>
      </div>
    </div>
  );
}
