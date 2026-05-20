import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * How long after a programmatic `scrollIntoView` we keep attributing
 * `scroll` events to that animation rather than to the user. A smooth
 * scroll emits a burst of `scroll` events over its duration; without this
 * window each one would look like manual intent and cancel auto-follow the
 * instant it was armed.
 */
const PROGRAMMATIC_SCROLL_WINDOW_MS = 600;

/**
 * Keeps the currently-active task row visible in the Tasks sidebar as the
 * agent works through its list — and yields the moment the user scrolls.
 *
 * This is deliberately *not* `useStickyScroll`. Chat appends new items at
 * the bottom, so it pins `scrollTop = scrollHeight`. The Tasks list renders
 * top-down (Current → Subagents → Siblings → History): new work lands
 * inside the Current section near the top while History can be hundreds of
 * rows tall. Pinning the literal bottom would scroll *away* from active
 * work, so this hook scrolls the active row into view with
 * `scrollIntoView({ block: "nearest" })` instead.
 *
 * Re-follow model (chosen in issue 878): a manual scroll latches
 * auto-follow OFF and only the "Jump to current" pill (`jumpToActive`)
 * re-arms it. Task transitions alone never move the list once the user has
 * taken control — so the list stays exactly where the user left it.
 *
 * Reuses the user-intent-version pattern from `useStickyScroll`: a manual
 * gesture bumps `userScrollVersionRef`; auto-follow is armed iff that
 * counter still equals `followVersionRef` (the snapshot taken when follow
 * was last armed).
 *
 * @param containerRef the scroll surface (a `BoundedScrollPane`).
 * @param activeTaskId id of the active task, or `null` when there is none.
 *        Changing it is the sole trigger for an auto-scroll.
 */
export function useActiveTaskScroll(
  containerRef: RefObject<HTMLElement | null>,
  activeTaskId: string | null,
) {
  // DOM node of the active task row. The caller attaches this to whichever
  // row it considers active; React keeps `.current` in lockstep as that
  // row changes.
  const activeTaskRef = useRef<HTMLDivElement>(null);
  // Bumped on every gesture that signals manual scroll intent.
  const userScrollVersionRef = useRef(0);
  // Snapshot of `userScrollVersionRef` taken the last time auto-follow was
  // armed (initial mount + every "Jump to current" click). Auto-follow is
  // active iff the live counter still equals this snapshot.
  const followVersionRef = useRef(0);
  // Timestamp until which `scroll` events are treated as our own
  // `scrollIntoView` animation rather than as manual intent.
  const programmaticUntilRef = useRef(0);
  // Latest `activeTaskId`, read by listener closures without re-binding.
  const activeTaskIdRef = useRef(activeTaskId);
  activeTaskIdRef.current = activeTaskId;

  const [showPill, setShowPill] = useState(false);

  const isFollowing = useCallback(
    () => userScrollVersionRef.current === followVersionRef.current,
    [],
  );

  const isActiveTaskOffScreen = useCallback(() => {
    const container = containerRef.current;
    const row = activeTaskRef.current;
    if (!container || !row) return false;
    const c = container.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    // Fully above the viewport or fully below it.
    return r.bottom <= c.top || r.top >= c.bottom;
  }, [containerRef]);

  const recomputePill = useCallback(() => {
    // The pill is the "you scrolled away — click to come back" affordance.
    // While auto-follow is still armed the active row is being kept in view
    // for the user, so there is nothing to jump to.
    if (activeTaskIdRef.current == null || isFollowing()) {
      setShowPill(false);
      return;
    }
    setShowPill(isActiveTaskOffScreen());
  }, [isFollowing, isActiveTaskOffScreen]);

  const scrollActiveIntoView = useCallback(() => {
    const row = activeTaskRef.current;
    if (!row) return;
    programmaticUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_WINDOW_MS;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);

  /**
   * Re-arm auto-follow and bring the active row back into view. Wired to
   * the "Jump to current" pill — the only thing that re-arms following once
   * the user has scrolled away (issue 878 re-follow model).
   */
  const jumpToActive = useCallback(() => {
    followVersionRef.current = userScrollVersionRef.current;
    scrollActiveIntoView();
    setShowPill(false);
  }, [scrollActiveIntoView]);

  // The sole auto-scroll trigger: the active task changed (e.g. the agent
  // flipped task 30 from pending → in_progress). A container or sidebar
  // resize deliberately never moves the list on its own.
  useEffect(() => {
    if (activeTaskId == null) {
      setShowPill(false);
      return;
    }
    if (isFollowing()) {
      scrollActiveIntoView();
      setShowPill(false);
    } else {
      recomputePill();
    }
  }, [activeTaskId, isFollowing, scrollActiveIntoView, recomputePill]);

  // Bind scroll-intent + pill-visibility listeners once the container is
  // mounted. The container is stable for the lifetime of the panel, so this
  // effect runs once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const markIntent = () => {
      userScrollVersionRef.current += 1;
    };

    // wheel / touch / keyboard are unambiguous user gestures — never
    // synthesised by `scrollIntoView` — so they latch auto-follow off
    // unconditionally and refresh the pill straight away.
    const onGesture = () => {
      markIntent();
      recomputePill();
    };
    // `scroll` additionally covers scrollbar-drag, but our own smooth scroll
    // emits `scroll` too — ignore those within the programmatic window so
    // auto-follow can't cancel itself.
    const onScroll = () => {
      if (Date.now() >= programmaticUntilRef.current) markIntent();
      recomputePill();
    };

    let rafScheduled = false;
    let disposed = false;
    const scheduleRecompute = () => {
      if (rafScheduled || disposed) return;
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        if (!disposed) recomputePill();
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onGesture, { passive: true });
    el.addEventListener("touchmove", onGesture, { passive: true });
    el.addEventListener("keydown", onGesture);

    // A height change (sidebar/window resize) can push the active row out
    // of view — refresh the pill, but never auto-scroll.
    const resizeObserver = new ResizeObserver(scheduleRecompute);
    resizeObserver.observe(el);
    // Content churn (new tasks, RunSummary expand/collapse) shifts the
    // active row without an id transition — keep the pill honest.
    const mutationObserver = new MutationObserver(scheduleRecompute);
    mutationObserver.observe(el, { childList: true, subtree: true });

    return () => {
      disposed = true;
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onGesture);
      el.removeEventListener("touchmove", onGesture);
      el.removeEventListener("keydown", onGesture);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [containerRef, recomputePill]);

  return { activeTaskRef, showPill, jumpToActive } as const;
}
