import { useState, type ReactNode } from "react";
import {
  FileCode,
  FileSpreadsheet,
  FileText,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";

import styles from "./MessageAttachment.module.css";

/** Format byte count as "B" / "KB" / "MB" with one decimal where useful. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ICONS: Record<string, LucideIcon> = {
  "text/csv": FileSpreadsheet,
  "text/markdown": FileText,
  "application/json": FileCode,
  "text/plain": FileText,
};

/**
 * Common shell used by the CSV / Markdown / JSON / plain-text cards:
 * a header (icon + filename + size) and a body that — when `collapsible`
 * is true — clamps to ~320px (set in CSS via `.body { max-height: 320px }`)
 * with a "Expand" / "Collapse" toggle.
 *
 * `onContextMenu` lets the call site wire the same Download / Copy / Open
 * menu image attachments use. The header also renders a kebab button that
 * fires the same handler with synthesized client coords — this gives the
 * menu a visible affordance on top of the discoverable-only right-click,
 * matching how images surface their actions.
 */
export function AttachmentCardShell({
  filename,
  mediaType,
  sizeBytes,
  collapsible,
  onContextMenu,
  children,
}: {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  /** When true, the body clamps to ~320px and offers an expand toggle. */
  collapsible: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = ICONS[mediaType] ?? FileText;

  return (
    <div
      className={styles.card}
      onContextMenu={onContextMenu}
      data-testid="message-attachment-card"
      data-media-type={mediaType}
    >
      <div className={styles.header}>
        <span className={styles.headerIcon}>
          <Icon size={14} aria-hidden />
        </span>
        <span className={styles.filename} title={filename}>
          {filename}
        </span>
        <span className={styles.size}>{formatBytes(sizeBytes)}</span>
        {onContextMenu && (
          <button
            type="button"
            className={styles.menuButton}
            aria-label="File actions"
            title="File actions"
            data-testid="attachment-menu-trigger"
            onClick={(e) => {
              // Anchor the popover to the kebab itself rather than the
              // raw click coords — left-click anywhere on the button
              // (including dead pixels around the icon) feels like the
              // same target, so the menu shouldn't drift.
              const rect = e.currentTarget.getBoundingClientRect();
              const synthetic = {
                ...e,
                preventDefault: () => e.preventDefault(),
                clientX: rect.right,
                clientY: rect.bottom,
              } as unknown as React.MouseEvent;
              onContextMenu(synthetic);
            }}
          >
            <MoreHorizontal size={14} aria-hidden />
          </button>
        )}
      </div>
      <div
        className={
          expanded || !collapsible
            ? `${styles.body} ${styles.bodyExpanded}`
            : styles.body
        }
      >
        {children}
        {collapsible && !expanded && <div className={styles.fade} aria-hidden />}
      </div>
      {collapsible && (
        <button
          type="button"
          className={styles.expandToggle}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
    </div>
  );
}
