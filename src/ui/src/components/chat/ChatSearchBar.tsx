import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useAppStore, type ToolActivity } from "../../stores/useAppStore";
import { focusChatPrompt } from "../../utils/focusTargets";
import styles from "./ChatSearchBar.module.css";

const SEARCH_MARK_SELECTOR = "mark.cc-search-match";
const ACTIVE_CLASS = "cc-search-match-active";

// Stable empty-array sentinel so the Zustand selector below returns the
// same reference on every read when the workspace has no activities yet —
// otherwise `?? []` would create a fresh array each render and trip the
// selector's identity check, causing unnecessary effect re-runs.
const EMPTY_ACTIVITIES: ToolActivity[] = [];

/**
 * Walk every search mark within `scope` in document order and return the
 * unique `data-match-id` values, preserving first-seen order. Logical
 * matches that the highlight wrappers split across multiple <mark>s share
 * one id, so this function tells the bar both how many distinct matches
 * exist and the order to cycle through them.
 */
function collectOrderedMatchIds(scope: HTMLElement): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const marks = scope.querySelectorAll<HTMLElement>(SEARCH_MARK_SELECTOR);
  for (const m of Array.from(marks)) {
    const id = m.dataset.matchId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

/**
 * Minimal CSS attribute-value escape — the match ids we generate are
 * stringified integers today, but escaping the `\` and `"` characters
 * keeps `[data-match-id="…"]` selectors safe if the format ever changes.
 */
function cssEscape(value: string): string {
  return value.replace(/[\\"]/g, "\\$&");
}

interface Props {
  workspaceId: string;
  /** The chat panel's `.messages` container — used to scope DOM lookups so
   *  matches outside the active workspace's message list never bleed in. */
  scopeRef: React.RefObject<HTMLDivElement | null>;
}

export function ChatSearchBar({ workspaceId, scopeRef }: Props) {
  const { t } = useTranslation("chat");
  const open = useAppStore(
    (s) => s.chatSearch[workspaceId]?.open ?? false,
  );
  const query = useAppStore((s) => s.chatSearch[workspaceId]?.query ?? "");
  const matchIndex = useAppStore(
    (s) => s.chatSearch[workspaceId]?.matchIndex ?? -1,
  );
  const setQuery = useAppStore((s) => s.setChatSearchQuery);
  const setMatchIndex = useAppStore((s) => s.setChatSearchMatchIndex);
  const closeChatSearch = useAppStore((s) => s.closeChatSearch);

  // Trigger DOM-derived count + active-mark refresh after every commit that
  // could change which marks are in the DOM. `messageCount` /
  // `streamingLength` are sufficient for chat messages and streaming text
  // because new content always grows their length. Tool activities are
  // different: `updateToolActivity` mutates an existing activity's summary
  // in place, replacing the array but keeping the same length, so we
  // subscribe to the array reference instead of `.length` to catch
  // in-place summary edits.
  const messageCount = useAppStore(
    (s) => s.chatMessages[workspaceId]?.length ?? 0,
  );
  const streamingLength = useAppStore(
    (s) => s.streamingContent[workspaceId]?.length ?? 0,
  );
  const activities = useAppStore(
    (s) => s.toolActivities[workspaceId] ?? EMPTY_ACTIVITIES,
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const [matchCount, setMatchCount] = useState(0);

  // Auto-focus input when the bar opens (and when re-opening to a still-
  // mounted bar, focus may have moved away — re-grabbing it here keeps the
  // hotkey idempotent).
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [open]);

  // Tally matches and re-clamp the active index after every relevant render.
  // Counts unique `data-match-id` values rather than raw <mark> elements so
  // a single logical match split across multiple marks (e.g., "def " across
  // two Shiki spans) is reported as one entry in the counter and traversed
  // as a single step when cycling.
  //
  // Uses `useEffect` rather than `useLayoutEffect` so the DOM-mutation pass
  // in HighlightedMessageMarkdown / HighlightedPlainText (which run as their
  // own layout effects further down the tree, but as siblings of this bar)
  // has finished by the time the count runs. A layout-effect here would
  // race the wrappers and read a pre-highlight DOM.
  useEffect(() => {
    if (!open) return;
    const scope = scopeRef.current;
    if (!scope) {
      setMatchCount(0);
      return;
    }
    const ids = collectOrderedMatchIds(scope);
    const count = ids.length;
    setMatchCount(count);
    if (count === 0) {
      if (matchIndex !== -1) setMatchIndex(workspaceId, -1);
      return;
    }
    if (matchIndex === -1 || matchIndex >= count) {
      setMatchIndex(workspaceId, 0);
    }
  }, [
    open,
    query,
    messageCount,
    streamingLength,
    activities,
    matchIndex,
    setMatchIndex,
    workspaceId,
    scopeRef,
  ]);

  // Apply the .active class to every mark belonging to the active logical
  // match (multiple <mark>s may share the same data-match-id) and scroll
  // the first one into view.
  useEffect(() => {
    if (!open) return;
    const scope = scopeRef.current;
    if (!scope) return;
    const allMarks = scope.querySelectorAll<HTMLElement>(SEARCH_MARK_SELECTOR);
    for (const m of Array.from(allMarks)) m.classList.remove(ACTIVE_CLASS);
    const ids = collectOrderedMatchIds(scope);
    if (matchIndex < 0 || matchIndex >= ids.length) return;
    const activeId = ids[matchIndex];
    const activeMarks = scope.querySelectorAll<HTMLElement>(
      `${SEARCH_MARK_SELECTOR}[data-match-id="${cssEscape(activeId)}"]`,
    );
    if (activeMarks.length === 0) return;
    for (const m of Array.from(activeMarks)) m.classList.add(ACTIVE_CLASS);
    // Skip the smooth scroll for users who've opted into reduced motion —
    // the cycle would otherwise force a noticeable animation despite their
    // OS-level preference.
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    activeMarks[0].scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }, [open, query, matchIndex, matchCount, scopeRef]);

  const handleClose = () => {
    closeChatSearch(workspaceId);
    focusChatPrompt();
  };

  const handleNext = () => {
    if (matchCount === 0) return;
    const next = matchIndex < 0 ? 0 : (matchIndex + 1) % matchCount;
    setMatchIndex(workspaceId, next);
  };

  const handlePrev = () => {
    if (matchCount === 0) return;
    const prev =
      matchIndex < 0
        ? matchCount - 1
        : (matchIndex - 1 + matchCount) % matchCount;
    setMatchIndex(workspaceId, prev);
  };

  if (!open) return null;

  // Counter rules: show "n / N" when there are matches, "No matches" when
  // the query is non-empty but unmatched, blank when the query is empty.
  // `matchIndex` can briefly be -1 between a query change and the clamping
  // effect that lands on 0 — clamp here so the user never sees "0 / N".
  const displayMatchIndex = matchIndex < 0 ? 0 : matchIndex;
  const counter = !query
    ? ""
    : matchCount === 0
      ? t("chat_search_no_matches")
      : `${displayMatchIndex + 1} / ${matchCount}`;

  return (
    <div
      className={styles.bar}
      role="search"
      aria-label={t("chat_search_aria")}
      data-search-total={matchCount}
      data-search-active={matchIndex}
    >
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        placeholder={t("chat_search_placeholder")}
        value={query}
        onChange={(e) => setQuery(workspaceId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) handlePrev();
            else handleNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            handleClose();
          }
        }}
        // Prevent global Cmd+F handler from re-opening / re-focusing the bar
        // while typing — let the input own all keystrokes.
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
        disabled={matchCount === 0}
        aria-label={t("chat_search_prev")}
        title={t("chat_search_prev_title")}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        onClick={handleNext}
        disabled={matchCount === 0}
        aria-label={t("chat_search_next")}
        title={t("chat_search_next_title")}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        onClick={handleClose}
        aria-label={t("chat_search_close")}
        title={t("chat_search_close_title")}
      >
        <X size={14} />
      </button>
    </div>
  );
}
