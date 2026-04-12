import { useState, useRef, useEffect, Fragment } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./HeaderMenu.module.css";

interface MenuItem {
  value: string;
  label: string;
  group?: string;
}

interface HeaderMenuProps {
  label: string;
  items: MenuItem[];
  value?: string;
  disabled?: boolean;
  title?: string;
  onSelect: (value: string) => void;
}

export function HeaderMenu({
  label,
  items,
  value,
  disabled = false,
  title,
  onSelect,
}: HeaderMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const selectedItem = items.find((i) => i.value === value);
  const displayLabel = selectedItem?.label ?? label;

  return (
    <div className={styles.container} ref={ref}>
      <button
        className={styles.trigger}
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        title={title}
        type="button"
      >
        <span className={styles.label}>{displayLabel}</span>
        <ChevronDown size={10} className={styles.chevron} />
      </button>
      {open && (
        <div className={styles.menu}>
          {items.map((item, i) => {
            const showGroupHeader =
              item.group && (i === 0 || items[i - 1].group !== item.group);
            return (
              <Fragment key={item.value}>
                {showGroupHeader && (
                  <div className={styles.groupHeader}>{item.group}</div>
                )}
                <button
                  className={`${styles.item} ${item.value === value ? styles.itemActive : ""}`}
                  onClick={() => {
                    onSelect(item.value);
                    setOpen(false);
                  }}
                  type="button"
                >
                  {item.label}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
