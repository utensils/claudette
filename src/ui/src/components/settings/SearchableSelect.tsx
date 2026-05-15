import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Search as SearchIcon } from "lucide-react";
import styles from "./SearchableSelect.module.css";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** Option rendered at the top representing "no explicit choice". Omit
   *  to skip the auto row. */
  autoOption?: SearchableSelectOption;
  placeholder?: string;
  /** When omitted, falls back to the localized "Filter N options…" string. */
  searchPlaceholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * Single combobox replacement for the BackendCard's native `<select>` plus a
 * sibling filter input. Pattern: input-styled trigger button → popover with
 * a search field at the top + filtered list below. Selected option shows a
 * checkmark. Keyboard nav: Up/Down to traverse, Enter to commit, Esc to
 * close. Click-outside closes. The currently selected option stays visible
 * even when a filter would normally hide it, so the in-effect value is
 * never silently invisible.
 */
export function SearchableSelect({
  options,
  value,
  onChange,
  autoOption,
  placeholder,
  searchPlaceholder,
  ariaLabel,
  disabled,
}: SearchableSelectProps) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);

  // The list the popover renders: autoOption (when provided) + options.
  const allOptions = useMemo(
    () => (autoOption ? [autoOption, ...options] : options),
    [autoOption, options],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allOptions;
    return allOptions.filter((opt) =>
      `${opt.value} ${opt.label}`.toLowerCase().includes(q),
    );
  }, [allOptions, query]);

  // Always keep the currently selected option visible. Without this, typing
  // a filter that doesn't match the current value would make the active
  // choice disappear from the list — confusing for the user.
  const selectedOption = allOptions.find((o) => o.value === value);
  const selectedNotInFilter =
    selectedOption && !filtered.some((o) => o.value === selectedOption.value);
  const visible = selectedNotInFilter ? [selectedOption, ...filtered] : filtered;

  const currentLabel =
    selectedOption?.label ?? autoOption?.label ?? placeholder ?? "";
  const currentLabelMuted = !selectedOption;

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      const target = event.target as Node | null;
      if (target && popoverRef.current?.contains(target)) return;
      if (target && triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Focus search when popover opens; reset query when closed.
  useEffect(() => {
    if (open) {
      const handle = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(handle);
    }
    setQuery("");
    return undefined;
  }, [open]);

  // Reset highlight to the top whenever the filter changes the list shape.
  useEffect(() => {
    setActiveIndex(0);
  }, [visible.length, query]);

  // Scroll the active row into view on keyboard nav so the highlight is
  // never offscreen in a long list (Pi can return hundreds of models).
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function commit(optionValue: string) {
    onChange(optionValue);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleSearchKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, visible.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const choice = visible[activeIndex];
      if (choice) commit(choice.value);
    }
  }

  function handleTriggerKey(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen(true);
    }
  }

  // `totalCount` is what the user sees in the filter placeholder
  // (e.g. "Filter 42 models…"). Pass the real model count — the
  // synthetic Auto / "Use first available" row is a control, not a
  // model, so it must not inflate the count.
  const totalCount = options.length;
  const showStatus = query.trim().length > 0;
  const computedSearchPlaceholder =
    searchPlaceholder
    ?? t(
      "models_backend_filter_placeholder",
      "Filter {{count}} models…",
      { count: totalCount },
    );

  return (
    <div className={styles.wrapper}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKey}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span
          className={`${styles.triggerLabel} ${currentLabelMuted ? styles.triggerLabelMuted : ""}`}
        >
          {currentLabel}
        </span>
        <ChevronDown size={14} className={styles.chevron} aria-hidden />
      </button>
      {open && (
        <div ref={popoverRef} className={styles.popover}>
          <div className={styles.searchWrap}>
            <SearchIcon size={14} className={styles.searchIcon} aria-hidden />
            <input
              ref={searchRef}
              type="search"
              className={styles.searchInput}
              value={query}
              placeholder={computedSearchPlaceholder}
              aria-label={computedSearchPlaceholder}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKey}
            />
          </div>
          <div className={styles.list} role="listbox">
            {visible.length === 0 ? (
              <div className={styles.emptyState}>
                {t("models_backend_filter_no_match", "No models match this filter")}
              </div>
            ) : (
              visible.map((opt, index) => {
                const isActive = index === activeIndex;
                const isSelected = opt.value === value;
                return (
                  <button
                    ref={isActive ? activeRowRef : undefined}
                    type="button"
                    key={opt.value || "__auto__"}
                    role="option"
                    aria-selected={isSelected}
                    className={[
                      styles.item,
                      isActive ? styles.itemActive : "",
                      isSelected ? styles.itemSelected : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => commit(opt.value)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <span className={styles.itemLabel} title={opt.label}>
                      {opt.label}
                    </span>
                    {isSelected && <Check size={14} className={styles.check} aria-hidden />}
                  </button>
                );
              })
            )}
          </div>
          {showStatus && (
            <div className={styles.statusLine}>
              {t(
                "models_backend_filter_status",
                "Showing {{shown}} of {{total}}",
                {
                  shown: filtered.filter((opt) => opt !== autoOption).length,
                  total: totalCount,
                },
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
