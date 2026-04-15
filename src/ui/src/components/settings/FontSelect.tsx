import { useState, useRef, useEffect, type CSSProperties } from "react";
import type { FontOption } from "../../utils/fontSettings";
import styles from "./Settings.module.css";

interface FontSelectProps {
  options: FontOption[];
  value: string;
  onChange: (value: string) => void;
  /** If true, the current value is a custom font not in the options list. */
  isCustom?: boolean;
  /** "sans" or "mono" — determines the fallback stack for previews. */
  kind?: "sans" | "mono";
}

// Inline styles can't use var() — must use real font names as fallbacks.
const SANS_FALLBACK = "Inter, -apple-system, BlinkMacSystemFont, sans-serif";
const MONO_FALLBACK = '"JetBrains Mono", ui-monospace, "SF Mono", monospace';

/**
 * Custom dropdown that renders each font option in its own typeface.
 * Replaces the native <select> for font pickers so users can preview fonts.
 */
export function FontSelect({ options, value, onChange, isCustom, kind = "sans" }: FontSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useRef(`font-list-${Math.random().toString(36).slice(2, 8)}`).current;
  const fallback = kind === "mono" ? MONO_FALLBACK : SANS_FALLBACK;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const selectedLabel = isCustom
    ? value || "Custom..."
    : (options.find((o) => o.value === value)?.label ?? "Default");

  // Every option gets an explicit fontFamily so it doesn't inherit the
  // current --font-sans (which may be a decorative font like Zapfino).
  const fontStyle = (v: string): CSSProperties => {
    if (v && v !== "__custom__") return { fontFamily: `"${v}", ${fallback}` };
    return { fontFamily: fallback };
  };

  return (
    <div className={styles.fontPicker} ref={ref}>
      <button
        type="button"
        className={styles.fontPickerButton}
        style={fontStyle(isCustom ? "" : value)}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
      >
        {selectedLabel}
      </button>
      {open && (
        <div
          className={styles.fontPickerDropdown}
          role="listbox"
          id={listId}
          aria-label="Font selection"
        >
          {options.map((opt) => {
            const isSelected = !isCustom && opt.value === value;
            const cls = isSelected
              ? styles.fontPickerOptionSelected
              : styles.fontPickerOption;
            return (
              <button
                key={opt.value || "__default__"}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={cls}
                style={fontStyle(opt.value)}
                onClick={() => {
                  onChange(opt.value);
                  if (opt.value !== "__custom__") setOpen(false);
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
