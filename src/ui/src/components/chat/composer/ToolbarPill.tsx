import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./ToolbarPill.module.css";

interface ToolbarPillProps {
  icon?: ReactNode;
  label?: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  "data-tooltip"?: string;
  "data-tooltip-placement"?: "top" | "bottom";
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
  "data-tooltip": dataTooltip,
  "data-tooltip-placement": dataTooltipPlacement,
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
      data-tooltip={dataTooltip ?? title}
      data-tooltip-placement={dataTooltipPlacement}
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
