import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { focusChatPrompt } from "../../utils/focusTargets";
import styles from "./ChatSearchBar.module.css";

const SEARCH_MARK_SELECTOR = "mark.cc-search-match";
const ACTIVE_CLASS = "cc-search-match-active";

interface Props {
  workspaceId: string;
  /** The chat panel's `.messages` container — used to scope DOM lookups so
   *  matches outside the active workspace's message list never bleed in. */
  scopeRef: React.RefObject<HTMLDivElement | null>;
}

export function ChatSearchBar({ workspaceId, scopeRef }: Props) {
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
  // could change which marks are in the DOM. We listen to a few store-derived
  // signals (messageCount, streamingLength, activitiesLength) to know when
  // a re-tally is needed.
  const messageCount = useAppStore(
    (s) => s.chatMessages[workspaceId]?.length ?? 0,
  );
  const streamingLength = useAppStore(
    (s) => s.streamingContent[workspaceId]?.length ?? 0,
  );
  const activitiesLength = useAppStore(
    (s) => s.toolActivities[workspaceId]?.length ?? 0,
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
    const count = scope.querySelectorAll(SEARCH_MARK_SELECTOR).length;
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
    activitiesLength,
    matchIndex,
    setMatchIndex,
    workspaceId,
    scopeRef,
  ]);

  // Apply the .active class to the Nth mark and scroll it into view.
  useEffect(() => {
    if (!open) return;
    const scope = scopeRef.current;
    if (!scope) return;
    const marks = scope.querySelectorAll<HTMLElement>(SEARCH_MARK_SELECTOR);
    for (const m of Array.from(marks)) m.classList.remove(ACTIVE_CLASS);
    if (matchIndex < 0 || matchIndex >= marks.length) return;
    const active = marks[matchIndex];
    active.classList.add(ACTIVE_CLASS);
    // Skip the smooth scroll for users who've opted into reduced motion —
    // the cycle would otherwise force a noticeable animation despite their
    // OS-level preference.
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    active.scrollIntoView({
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
      ? "No matches"
      : `${displayMatchIndex + 1} / ${matchCount}`;

  return (
    <div
      className={styles.bar}
      role="search"
      aria-label="Search chat"
      data-search-total={matchCount}
      data-search-active={matchIndex}
    >
      <input
        ref={inputRef}
        type="text"
        className={styles.input}
        placeholder="Search chat…"
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
        aria-label="Search query"
      />
      <span className={styles.counter} aria-live="polite">
        {counter}
      </span>
      <button
        type="button"
        className={styles.iconButton}
        onClick={handlePrev}
        disabled={matchCount === 0}
        aria-label="Previous match"
        title="Previous (Shift+Enter)"
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        onClick={handleNext}
        disabled={matchCount === 0}
        aria-label="Next match"
        title="Next (Enter)"
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        onClick={handleClose}
        aria-label="Close search"
        title="Close (Esc)"
      >
        <X size={14} />
      </button>
    </div>
  );
}
