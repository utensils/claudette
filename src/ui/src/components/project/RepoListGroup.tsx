import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import styles from "./RepoListsSection.module.css";

export interface RepoListGroupProps {
  /// Group label, e.g. "In progress" or "Open".
  label: string;
  /// Count shown next to the label.
  count: number;
  /// Accent the header — used to make the "In progress" group stand
  /// apart from the plain "Open" group.
  accent?: boolean;
  /// Whether the group starts expanded. Defaults to expanded.
  defaultOpen?: boolean;
  children: ReactNode;
}

/// A collapsible labelled group inside a project-view list. Used to
/// split dispatched ("In progress") issues/PRs — ones that already
/// have a workspace — from the rest (issue #898). Collapse state is
/// local UI state, intentionally not persisted (matches the rest of
/// the project view's section chrome).
export function RepoListGroup({
  label,
  count,
  accent = false,
  defaultOpen = true,
  children,
}: RepoListGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={styles.group}>
      <button
        type="button"
        className={`${styles.groupHeader}${accent ? ` ${styles.groupHeaderAccent}` : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className={styles.groupLabel}>{label}</span>
        <span className={styles.groupCount}>{count}</span>
      </button>
      {open && children}
    </div>
  );
}
