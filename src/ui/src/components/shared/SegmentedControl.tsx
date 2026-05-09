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
        // Use `aria-disabled` (not the native `disabled` attribute) so hover
        // and focus still reach AppTooltip on disabled segments. That's how
        // users learn why Edit is unavailable on binary/oversize/image files.
        // Click is suppressed via the onClick guard. `aria-pressed` is still
        // emitted; the toggle's visual style flips through `.buttonActive`.
        return (
          <button
            key={opt.value}
            type="button"
            aria-disabled={opt.disabled || undefined}
            aria-pressed={isActive}
            className={`${styles.button} ${isActive ? styles.buttonActive : ""} ${opt.disabled ? styles.buttonDisabled : ""}`}
            onClick={() => {
              if (!opt.disabled) onChange(opt.value);
            }}
            data-tooltip={label}
            data-tooltip-placement="bottom"
            aria-label={label}
          >
            {opt.icon}
          </button>
        );
      })}
    </div>
  );
}
