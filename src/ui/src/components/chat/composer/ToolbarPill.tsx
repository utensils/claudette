import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./ToolbarPill.module.css";

interface ToolbarPillProps {
  icon?: ReactNode;
  label?: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  chevron?: boolean;
  onClick?: () => void;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  ariaLabel?: string;
  className?: string;
  children?: ReactNode;
}

export function ToolbarPill({
  icon,
  label,
  active,
  disabled,
  title,
  chevron,
  onClick,
  ariaPressed,
  ariaExpanded,
  ariaLabel,
  className,
  children,
}: ToolbarPillProps) {
  return (
    <button
      type="button"
      className={`${styles.pill} ${active ? styles.pillActive : ""} ${className ?? ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-label={ariaLabel}
    >
      {icon && <span className={styles.icon}>{icon}</span>}
      {label && <span className={styles.label}>{label}</span>}
      {children}
      {chevron && (
        <span className={styles.chevron}>
          <ChevronDown size={12} />
        </span>
      )}
    </button>
  );
}
