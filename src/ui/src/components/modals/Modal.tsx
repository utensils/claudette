import type { ReactNode } from "react";
import styles from "./Modal.module.css";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>{title}</h3>
        </div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
