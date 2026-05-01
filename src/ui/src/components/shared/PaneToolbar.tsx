import type { ReactNode } from "react";
import styles from "./PaneToolbar.module.css";

interface PaneToolbarProps {
  /** Left-aligned content, typically a relative file path. Long paths
   *  ellipsize leading directories so the filename stays visible. */
  path?: string;
  /** Show an unsaved-changes dot next to the path. */
  dirty?: boolean;
  /** Right-aligned controls (segmented controls, icon buttons). */
  actions: ReactNode;
}

export function PaneToolbar({ path, dirty, actions }: PaneToolbarProps) {
  return (
    <div className={styles.toolbar}>
      {path !== undefined && (
        <span
          className={`${styles.path} ${dirty ? styles.pathDirty : ""}`}
          title={path}
        >
          {path}
        </span>
      )}
      <div className={styles.actions}>{actions}</div>
    </div>
  );
}
