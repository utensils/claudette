import type { ReactNode } from "react";
import styles from "./SegmentedControl.module.css";

export interface SegmentedOption<T extends string> {
  value: T;
  icon: ReactNode;
  /** Tooltip shown on hover; also used as the aria-label. */
  tooltip: string;
  disabled?: boolean;
  /** Replaces tooltip + aria-label when present (e.g. "Edit (binary file)"). */
  disabledTooltip?: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Container aria-label (the role="group" wrapper). */
  ariaLabel: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div className={styles.group} role="group" aria-label={ariaLabel}>
      {options.map((opt) => {
        const isActive = opt.value === value;
        const label =
          opt.disabled && opt.disabledTooltip ? opt.disabledTooltip : opt.tooltip;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={opt.disabled}
            aria-pressed={isActive}
            className={`${styles.button} ${isActive ? styles.buttonActive : ""}`}
            onClick={() => {
              if (!opt.disabled) onChange(opt.value);
            }}
            title={label}
            aria-label={label}
          >
            {opt.icon}
          </button>
        );
      })}
    </div>
  );
}
