import type { KeyboardEvent, ReactNode } from "react";
import styles from "./ChatPanel.module.css";

/**
 * Clickable, keyboard-operable header for a collapsible transcript group
 * (tool-call groups, agent groups, completed-turn summaries). Owns the
 * `role="button"` / Enter / Space / chevron boilerplate every group header
 * used to repeat.
 */
export function DisclosureHeader({
  expanded,
  onToggle,
  className,
  ariaLabel,
  ariaControls,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  className: string;
  ariaLabel?: string;
  ariaControls?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={ariaLabel}
      aria-controls={ariaControls}
      onClick={onToggle}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <span className={styles.toolChevron}>{expanded ? "⌄" : "›"}</span>
      {children}
    </div>
  );
}
