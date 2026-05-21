import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { getTerminalSearchDecorations } from "../../utils/theme";
import styles from "./TerminalSearchBar.module.css";

interface Props {
  /** Search addon for the currently active pane. Null when no pane is active. */
  addon: SearchAddon | null;
  /** Current search query — owned by the parent so the value survives pane
   *  switches and re-opens. */
  query: string;
  onQueryChange: (next: string) => void;
  /** Close the bar and restore focus to whatever owns the active pane. */
  onClose: () => void;
  /** Bumped by the parent each time Cmd+F is pressed; triggers a re-focus
   *  + select of the input so re-pressing Cmd+F always lands the cursor
   *  back in the search box. */
  focusToken: number;
}

/**
 * In-panel search bar for the active xterm pane's scrollback. Drives the
 * @xterm/addon-search instance attached to that pane.
 *
 * Mirrors the chat search bar's interactions: Enter / Shift+Enter to step
 * matches, Esc to close, and a live counter sourced from the addon's
 * `onDidChangeResults` event.
 */
export function TerminalSearchBar({
  addon,
  query,
  onQueryChange,
  onClose,
  focusToken,
}: Props) {
  const { t } = useTranslation("chat");
  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });

  // Focus + select on mount AND whenever the parent bumps focusToken — that
  // covers both the initial open and a re-press of Cmd+F while the bar is
  // already mounted but unfocused (e.g. user clicked into the pane).
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  useEffect(() => {
    if (!addon) {
      setResults({ index: -1, count: 0 });
      return;
    }
    const sub = addon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResults({ index: resultIndex, count: resultCount });
    });
    return () => sub.dispose();
  }, [addon]);

  // Decoration options are required for `onDidChangeResults` to fire —
  // without them the counter stays at zero even when matches exist. The
  // helper resolves theme colors at call time so theme switches mid-search
  // pick up new accent values on the next keystroke.
  const baseSearchOptions = useMemo<ISearchOptions>(
    () => ({ decorations: getTerminalSearchDecorations() }),
    [],
  );

  // Re-run findNext when the query changes so the counter and highlighted
  // match update incrementally as the user types. `incremental: true`
  // expands the current selection while it still matches — matching the
  // behavior of Cmd+F in browsers.
  useEffect(() => {
    if (!addon) return;
    if (query.length === 0) {
      addon.clearDecorations();
      setResults({ index: -1, count: 0 });
      return;
    }
    addon.findNext(query, { ...baseSearchOptions, incremental: true });
  }, [addon, query, baseSearchOptions]);

  const handleNext = () => {
    if (!addon || query.length === 0) return;
    addon.findNext(query, baseSearchOptions);
  };

  const handlePrev = () => {
    if (!addon || query.length === 0) return;
    addon.findPrevious(query, baseSearchOptions);
  };

  const displayMatchIndex = results.index < 0 ? 0 : results.index + 1;
  const counter = !query
    ? ""
    : results.count === 0
      ? t("chat_search_no_matches")
      : `${displayMatchIndex} / ${results.count}`;

  return (
    <div
      className={styles.bar}
      role="search"
      aria-label={t("terminal_search_aria", { defaultValue: "Search terminal" })}
      data-search-total={results.count}
      data-search-active={results.index}
    >
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        placeholder={t("terminal_search_placeholder", {
          defaultValue: "Search terminal…",
        })}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) handlePrev();
            else handleNext();
          } else if (e.key === "Escape") {
            // Stop propagation so the window-level Esc handler doesn't
            // fall through to "stop running agent" — terminal search
            // state is panel-local, so that handler has no way to know
            // an overlay just absorbed the keystroke.
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        // Stop Cmd/Ctrl+F from bubbling to the global handler while the bar
        // is focused — re-select the input so the user can replace the query
        // with another Cmd+F press.
        onKeyDownCapture={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.code === "KeyF") {
            e.preventDefault();
            e.stopPropagation();
            inputRef.current?.select();
          }
        }}
        aria-label={t("chat_search_query_aria")}
      />
      <span className={styles.counter} aria-live="polite">
        {counter}
      </span>
      <button
        type="button"
        className={styles.iconButton}
        onClick={handlePrev}
        disabled={!addon || results.count === 0}
        aria-label={t("chat_search_prev")}
        title={t("chat_search_prev_title")}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        onClick={handleNext}
        disabled={!addon || results.count === 0}
        aria-label={t("chat_search_next")}
        title={t("chat_search_next_title")}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        onClick={onClose}
        aria-label={t("chat_search_close")}
        title={t("chat_search_close_title")}
      >
        <X size={14} />
      </button>
    </div>
  );
}
