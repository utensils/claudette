// @vitest-environment happy-dom

// Regression suite for the chat's custom DOM scrollbar.
//
// `<OverlayScrollbar />` exists because macOS WKWebView keeps using the
// OS overlay scrollbar regardless of `::-webkit-scrollbar` styling, and
// OS overlay scrollbars don't scale with browser zoom — so chat,
// xterm.js's slider, and Monaco's slider would visibly drift apart at
// non-100% zoom. This file pins:
//
//   1. The component renders a track + slider pair under the
//      CSS-module classes the call site relies on.
//   2. Overflow gating: the data attribute and slider visibility
//      flip with the target's scrollHeight / clientHeight ratio.
//   3. Slider geometry math (proportional height with a minimum,
//      proportional top derived from scrollTop).
//   4. Live updates via the target's scroll event, ResizeObserver,
//      and MutationObserver — all three fire `update()` so streaming
//      message growth tracks correctly.
//   5. RAF coalescing: rapid mutations within a frame collapse to one
//      setState batch (otherwise streaming-token mutations cause one
//      re-render per token).
//   6. Drag mapping: a pointermove delta translates into the right
//      scrollTop delta (inverse of slider/content ratio), with
//      clamping at both ends.
//   7. Track click-to-page: clicking the track above or below the
//      slider pages the viewport in that direction (parity with
//      native macOS scrollbar + Monaco).
//   8. Edge cases: null `targetRef.current`, drag with
//      `usableTrack === 0`, non-primary mouse buttons.
//   9. Observer + listener cleanup on unmount, so component churn
//      doesn't leak handlers onto the messages container.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayScrollbar } from "./OverlayScrollbar";
import styles from "./OverlayScrollbar.module.css";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
  vi.restoreAllMocks();
});

/** Stub the three layout properties OverlayScrollbar reads. happy-dom
 *  doesn't compute layout, so without overrides scrollHeight ===
 *  clientHeight === 0 and the component believes nothing overflows. */
function configureScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop?: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => (el as HTMLElement & { _scrollTop?: number })._scrollTop ?? 0,
    set: (v: number) => {
      (el as HTMLElement & { _scrollTop?: number })._scrollTop = v;
    },
  });
  if (metrics.scrollTop != null) el.scrollTop = metrics.scrollTop;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
}

/** Capturing stub of ResizeObserver / MutationObserver so tests can
 *  trigger the callbacks and verify the component reacts. happy-dom's
 *  ResizeObserver never fires on layout changes (since there is no
 *  layout), and a real MutationObserver requires actual DOM mutations
 *  inside the target — both are easier to drive by hand.
 *
 *  We also capture `requestAnimationFrame` so tests can flush the
 *  component's RAF gate explicitly. Without this, post-mount events
 *  (scroll, resize, mutation) all schedule via RAF and tests would
 *  observe stale state. The default `flushRaf()` helper drains the
 *  queue so callers see "what would render next frame". One specific
 *  test in this file deliberately holds the queue back to assert that
 *  rapid events coalesce. */
type Capture = {
  resizeCallback: ResizeObserverCallback | null;
  mutationCallback: MutationCallback | null;
  resizeDisconnectCount: number;
  mutationDisconnectCount: number;
  rafCalls: number;
  rafQueue: FrameRequestCallback[];
};

let capture: Capture;

function installCaptures(): Capture {
  const cap: Capture = {
    resizeCallback: null,
    mutationCallback: null,
    resizeDisconnectCount: 0,
    mutationDisconnectCount: 0,
    rafCalls: 0,
    rafQueue: [],
  };
  globalThis.ResizeObserver = vi
    .fn()
    .mockImplementation(function (cb: ResizeObserverCallback) {
      cap.resizeCallback = cb;
      return {
        observe: () => undefined,
        unobserve: () => undefined,
        disconnect: () => {
          cap.resizeDisconnectCount += 1;
        },
      };
    }) as unknown as typeof globalThis.ResizeObserver;
  globalThis.MutationObserver = vi
    .fn()
    .mockImplementation(function (cb: MutationCallback) {
      cap.mutationCallback = cb;
      return {
        observe: () => undefined,
        disconnect: () => {
          cap.mutationDisconnectCount += 1;
        },
        takeRecords: () => [],
      };
    }) as unknown as typeof globalThis.MutationObserver;
  // Hold RAF callbacks in a queue rather than firing them synchronously
  // so tests can assert "one RAF was scheduled per N rapid events".
  // `flushRaf()` drains the queue when the test wants the deferred work
  // to land.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cap.rafCalls += 1;
    cap.rafQueue.push(cb);
    return cap.rafCalls;
  }) as typeof globalThis.requestAnimationFrame;
  return cap;
}

async function flushRaf() {
  const callbacks = capture.rafQueue.splice(0);
  await act(async () => {
    for (const cb of callbacks) cb(0);
  });
}

/**
 * Test harness that mounts the component against a real <div> the test
 * can resize via `configureScrollMetrics`. Returns the slider, track,
 * and the target element so each case can drive scrollTop directly.
 *
 * `nullTarget` lets a test simulate the case where the parent hasn't
 * mounted the scroll element yet (e.g., a workspace switching mid-render
 * before `messagesContainerRef.current` is populated).
 */
function Harness({
  metrics,
  nullTarget,
  onTargetReady,
}: {
  metrics?: { scrollTop?: number; scrollHeight: number; clientHeight: number };
  nullTarget?: boolean;
  onTargetReady?: (el: HTMLDivElement) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div data-testid="wrapper" style={{ position: "relative" }}>
      {!nullTarget && (
        <div
          data-testid="target"
          ref={(el) => {
            ref.current = el;
            if (el && metrics) {
              configureScrollMetrics(el, metrics);
              onTargetReady?.(el);
            }
          }}
        />
      )}
      <OverlayScrollbar targetRef={ref} />
    </div>
  );
}

beforeEach(() => {
  capture = installCaptures();
});

describe("OverlayScrollbar", () => {
  it("renders a track + slider pair under the module's CSS-module classes", async () => {
    const container = await render(
      <Harness metrics={{ scrollHeight: 1000, clientHeight: 400 }} />,
    );
    const track = container.querySelector(`.${styles.track}`);
    const slider = container.querySelector(`.${styles.slider}`);
    expect(track).toBeTruthy();
    expect(slider).toBeTruthy();
    // Track is decoration; assistive tech should skip it.
    expect(track?.getAttribute("aria-hidden")).toBe("true");
  });

  it("marks the track non-overflowing and hides the slider when content fits", async () => {
    const container = await render(
      <Harness metrics={{ scrollHeight: 100, clientHeight: 400 }} />,
    );
    const track = container.querySelector(
      `.${styles.track}`,
    ) as HTMLElement | null;
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement | null;
    expect(track?.dataset.overflowing).toBe("false");
    // Slider's display is set inline so it can't intercept pointer events
    // while the track fades; verify that's the case when no overflow.
    expect(slider?.style.display).toBe("none");
  });

  it("flips overflowing + reveals the slider once content exceeds the viewport", async () => {
    const container = await render(
      <Harness metrics={{ scrollHeight: 1000, clientHeight: 400 }} />,
    );
    const track = container.querySelector(
      `.${styles.track}`,
    ) as HTMLElement | null;
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement | null;
    expect(track?.dataset.overflowing).toBe("true");
    expect(slider?.style.display).toBe("block");
  });

  it("scales slider height by viewport/content ratio with a 24px minimum", async () => {
    // 1000px content, 400px viewport: raw = 400 * (400/1000) = 160px.
    const container = await render(
      <Harness metrics={{ scrollHeight: 1000, clientHeight: 400 }} />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    expect(slider.style.height).toBe("160px");
  });

  it("clamps very tall content to the 24px minimum slider height", async () => {
    // 100000px content, 400px viewport: raw = 400 * (400/100000) = 1.6px.
    // Without the floor the user would have nothing to grab.
    const container = await render(
      <Harness metrics={{ scrollHeight: 100000, clientHeight: 400 }} />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    expect(slider.style.height).toBe("24px");
  });

  it("positions the slider proportional to scrollTop / scrollRange", async () => {
    // 1000 content - 400 viewport = 600 scrollRange. Slider 160px →
    // usable rail (clientHeight - sliderHeight) = 240px. At
    // scrollTop=300 (50% scrolled) the slider top should be 120px.
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    expect(slider.style.transform).toBe("translateY(120px)");
    expect(target.scrollTop).toBe(300);
  });

  it("re-runs update when the target fires a scroll event", async () => {
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    expect(slider.style.transform).toBe("translateY(0px)");
    target.scrollTop = 600;
    target.dispatchEvent(new Event("scroll"));
    await flushRaf();
    // 600 / 600 = 100% → slider top = usableTrack = 240px.
    expect(slider.style.transform).toBe("translateY(240px)");
  });

  it("re-runs update when the ResizeObserver fires (window/flex reflow)", async () => {
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    expect(slider.style.height).toBe("160px");
    configureScrollMetrics(target, { scrollHeight: 1000, clientHeight: 800 });
    capture.resizeCallback!(
      [] as unknown as ResizeObserverEntry[],
      {} as ResizeObserver,
    );
    await flushRaf();
    // 800 / 1000 ratio of new viewport: 800 * 0.8 = 640px slider.
    expect(slider.style.height).toBe("640px");
  });

  it("re-runs update when the MutationObserver fires (streaming new content)", async () => {
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    expect(slider.style.height).toBe("160px");
    // Streaming a long agent reply doubles the content; without the
    // mutation observer firing, the slider would stay at the old
    // 160px and feel "stuck" mid-stream.
    configureScrollMetrics(target, {
      scrollHeight: 2000,
      clientHeight: 400,
    });
    capture.mutationCallback!(
      [] as MutationRecord[],
      {} as MutationObserver,
    );
    await flushRaf();
    // 400 * (400 / 2000) = 80px.
    expect(slider.style.height).toBe("80px");
  });

  it("coalesces a burst of events into a single RAF (avoids per-token re-renders during streaming)", async () => {
    // Regression: useStickyScroll and OverlayScrollbar both observe the
    // messages list. `useStickyScroll.handleContentChanged` already
    // RAF-coalesces (see `hooks/useStickyScroll.ts`); OverlayScrollbar
    // must do the same or else streaming token mutations trigger one
    // setState per token. This test fires 10 events and asserts only
    // one RAF was scheduled until we drain the queue.
    let target!: HTMLDivElement;
    await render(
      <Harness
        metrics={{ scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    // Initial mount calls update() synchronously (no RAF used) and
    // doesn't schedule a RAF; the first scheduled RAF is the next user
    // event. Reset the counter to isolate the burst.
    capture.rafCalls = 0;
    capture.rafQueue.length = 0;
    for (let i = 0; i < 10; i++) {
      target.dispatchEvent(new Event("scroll"));
    }
    expect(capture.rafCalls).toBe(1);
    expect(capture.rafQueue.length).toBe(1);
    // Draining the queue lets the next burst schedule a fresh RAF;
    // verify the gate doesn't lock permanently.
    await flushRaf();
    target.dispatchEvent(new Event("scroll"));
    expect(capture.rafCalls).toBe(2);
  });

  it("does not throw when targetRef.current is null at mount", async () => {
    const container = await render(<Harness nullTarget />);
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    const track = container.querySelector(
      `.${styles.track}`,
    ) as HTMLElement;
    // No target → the component renders a non-overflowing track and
    // silently waits. No errors, no observers attached (resize/mutation
    // ctors are still constructed, but observe() is never called on a
    // real element); cleanup unmount runs without throwing.
    expect(track.dataset.overflowing).toBe("false");
    expect(slider.style.display).toBe("none");
  });

  it("disconnects observers and removes the scroll listener on unmount", async () => {
    let target!: HTMLDivElement;
    const removeSpy = vi.fn();
    const container = await render(
      <Harness
        metrics={{ scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
          const original = target.removeEventListener.bind(target);
          target.removeEventListener = ((
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | EventListenerOptions,
          ) => {
            if (type === "scroll") removeSpy();
            return original(type, listener, options);
          }) as typeof target.removeEventListener;
        }}
      />,
    );
    expect(capture.resizeDisconnectCount).toBe(0);
    expect(capture.mutationDisconnectCount).toBe(0);
    // Unmount via the harness root.
    const root = mountedRoots[mountedRoots.length - 1];
    await act(async () => {
      root.unmount();
    });
    container.remove();
    mountedRoots.pop();
    mountedContainers.pop();
    expect(capture.resizeDisconnectCount).toBe(1);
    expect(capture.mutationDisconnectCount).toBe(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("OverlayScrollbar drag mapping", () => {
  /** Build a synthetic PointerEvent. happy-dom doesn't ship a
   *  `PointerEvent` constructor on every release, so we forge one out of
   *  a MouseEvent + extra fields the component reads (clientY,
   *  pointerId, button, capture helpers). */
  function pointerDown(target: HTMLElement, clientY: number) {
    const ev = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    }) as MouseEvent & { pointerId: number; clientY: number; button: number };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    Object.defineProperty(ev, "clientY", { value: clientY });
    Object.defineProperty(ev, "button", { value: 0 });
    target.dispatchEvent(ev);
  }

  function pointerMove(target: HTMLElement, clientY: number) {
    const ev = new MouseEvent("pointermove") as MouseEvent & {
      pointerId: number;
      clientY: number;
    };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    Object.defineProperty(ev, "clientY", { value: clientY });
    target.dispatchEvent(ev);
  }

  function pointerUp(target: HTMLElement) {
    const ev = new MouseEvent("pointerup") as MouseEvent & {
      pointerId: number;
    };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    target.dispatchEvent(ev);
  }

  it("drags scrollTop in proportion to the inverse of the viewport/content ratio", async () => {
    // 1000 content, 400 viewport, slider height 160 → usable rail 240,
    // scrollRange 600. Each 1px of slider travel = 600/240 = 2.5px
    // of scrollTop. Dragging from y=0 to y=100 should move scroll by
    // 250.
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    Object.defineProperty(slider, "offsetHeight", {
      configurable: true,
      value: 160,
    });
    // setPointerCapture / releasePointerCapture aren't implemented in
    // happy-dom; stub them so the handler runs.
    slider.setPointerCapture = vi.fn();
    slider.releasePointerCapture = vi.fn();
    await act(async () => {
      pointerDown(slider, 0);
    });
    expect(slider.dataset.dragging).toBe("true");
    pointerMove(slider, 100);
    expect(target.scrollTop).toBe(250);
    await act(async () => {
      pointerUp(slider);
    });
    expect(slider.dataset.dragging).toBe("false");
  });

  it("clamps drag-driven scrollTop to [0, scrollRange]", async () => {
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    Object.defineProperty(slider, "offsetHeight", {
      configurable: true,
      value: 160,
    });
    slider.setPointerCapture = vi.fn();
    slider.releasePointerCapture = vi.fn();
    await act(async () => {
      pointerDown(slider, 0);
    });
    pointerMove(slider, 10000);
    // Even with a runaway pointer delta the component clamps to
    // scrollRange = scrollHeight - clientHeight = 600.
    expect(target.scrollTop).toBe(600);
    pointerMove(slider, -10000);
    expect(target.scrollTop).toBe(0);
    await act(async () => {
      pointerUp(slider);
    });
  });

  it("ignores non-primary mouse buttons so right-click doesn't start a drag", async () => {
    const container = await render(
      <Harness metrics={{ scrollHeight: 1000, clientHeight: 400 }} />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    Object.defineProperty(slider, "offsetHeight", {
      configurable: true,
      value: 160,
    });
    slider.setPointerCapture = vi.fn();
    slider.releasePointerCapture = vi.fn();
    const ev = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    }) as MouseEvent & { pointerId: number; clientY: number; button: number };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    Object.defineProperty(ev, "clientY", { value: 0 });
    Object.defineProperty(ev, "button", { value: 2 });
    slider.dispatchEvent(ev);
    expect(slider.dataset.dragging).toBe("false");
    expect(slider.setPointerCapture).not.toHaveBeenCalled();
  });

  it("safely no-ops the drag when slider equals viewport height (usableTrack === 0)", async () => {
    // Edge case: at the 24px slider-height floor with a 24px viewport,
    // usableTrack = 0 and scale = 0. The drag must not divide by zero
    // or push scrollTop out of bounds. Construct a synthetic case
    // where the slider fills the entire viewport.
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollTop: 100, scrollHeight: 200, clientHeight: 50 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    // Force slider to exactly the viewport height for this test.
    Object.defineProperty(slider, "offsetHeight", {
      configurable: true,
      value: 50,
    });
    slider.setPointerCapture = vi.fn();
    slider.releasePointerCapture = vi.fn();
    const startScroll = target.scrollTop;
    await act(async () => {
      pointerDown(slider, 0);
    });
    pointerMove(slider, 999);
    // scale = 0, so scrollTop should be unchanged regardless of move
    // distance. The clamp also keeps it inside [0, scrollRange = 150].
    expect(target.scrollTop).toBe(startScroll);
    await act(async () => {
      pointerUp(slider);
    });
  });
});

describe("OverlayScrollbar track click-to-page", () => {
  function trackPointerDown(track: HTMLElement, clientY: number) {
    // Track click handler reads `e.target` and `e.currentTarget`.
    // dispatchEvent on the track sets target = currentTarget (the
    // event element) which is what we want for a "click on the track,
    // not the slider" scenario.
    const ev = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    }) as MouseEvent & { pointerId: number; clientY: number; button: number };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    Object.defineProperty(ev, "clientY", { value: clientY });
    Object.defineProperty(ev, "button", { value: 0 });
    track.dispatchEvent(ev);
  }

  it("pages down by clientHeight when the click lands below the slider", async () => {
    // 1000 content, 400 viewport, scrollTop 0 → page down should land
    // at scrollTop = 400 (or clamped to scrollRange = 600).
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const track = container.querySelector(`.${styles.track}`) as HTMLElement;
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    // Slider at top: top=0, height=160 → bottom at y=160. A click at
    // y=300 is "below the slider".
    Object.defineProperty(slider, "getBoundingClientRect", {
      value: () => ({
        top: 0,
        bottom: 160,
        height: 160,
        left: 0,
        right: 8,
        width: 8,
        x: 0,
        y: 0,
        toJSON: () => null,
      }),
    });
    trackPointerDown(track, 300);
    await flushRaf();
    expect(target.scrollTop).toBe(400);
  });

  it("pages up by clientHeight when the click lands above the slider", async () => {
    // 1000 content, 400 viewport, scrollTop 500 → page up should land
    // at scrollTop = 100.
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const track = container.querySelector(`.${styles.track}`) as HTMLElement;
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    // Slider mid-track at top=200 (matches scrollTop 500/600 ≈ 83% of
    // usable rail 240 = 200 ± rounding). Click at y=50 is above.
    Object.defineProperty(slider, "getBoundingClientRect", {
      value: () => ({
        top: 200,
        bottom: 360,
        height: 160,
        left: 0,
        right: 8,
        width: 8,
        x: 0,
        y: 200,
        toJSON: () => null,
      }),
    });
    trackPointerDown(track, 50);
    await flushRaf();
    expect(target.scrollTop).toBe(100);
  });

  it("clamps page-jump to scrollRange so it doesn't run off the end", async () => {
    // scrollTop near the bottom; page-down should clamp to
    // scrollHeight - clientHeight, not overshoot.
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const track = container.querySelector(`.${styles.track}`) as HTMLElement;
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    Object.defineProperty(slider, "getBoundingClientRect", {
      value: () => ({
        top: 200,
        bottom: 360,
        height: 160,
        left: 0,
        right: 8,
        width: 8,
        x: 0,
        y: 200,
        toJSON: () => null,
      }),
    });
    trackPointerDown(track, 380);
    await flushRaf();
    expect(target.scrollTop).toBe(600);
  });

  it("ignores track clicks when the click lands on the slider (slider handler takes the event)", async () => {
    // The slider's onPointerDown stops propagation and the track
    // handler short-circuits when target !== currentTarget. To exercise
    // this without a real bubbling event, dispatch directly on the
    // slider with target === slider, and assert scrollTop didn't jump
    // by clientHeight (the slider-drag path uses scale * delta — with
    // delta 0 it shouldn't move).
    let target!: HTMLDivElement;
    const container = await render(
      <Harness
        metrics={{ scrollTop: 200, scrollHeight: 1000, clientHeight: 400 }}
        onTargetReady={(el) => {
          target = el;
        }}
      />,
    );
    const slider = container.querySelector(
      `.${styles.slider}`,
    ) as HTMLElement;
    Object.defineProperty(slider, "offsetHeight", {
      configurable: true,
      value: 160,
    });
    slider.setPointerCapture = vi.fn();
    slider.releasePointerCapture = vi.fn();
    const startScroll = target.scrollTop;
    const ev = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    }) as MouseEvent & { pointerId: number; clientY: number; button: number };
    Object.defineProperty(ev, "pointerId", { value: 1 });
    Object.defineProperty(ev, "clientY", { value: 0 });
    Object.defineProperty(ev, "button", { value: 0 });
    await act(async () => {
      slider.dispatchEvent(ev);
    });
    // The slider's drag started; release without moving.
    const upEv = new MouseEvent("pointerup") as MouseEvent & {
      pointerId: number;
    };
    Object.defineProperty(upEv, "pointerId", { value: 1 });
    await act(async () => {
      slider.dispatchEvent(upEv);
    });
    // No movement → scrollTop unchanged. Crucially, no page-jump
    // happened (page-down would have added clientHeight = 400).
    expect(target.scrollTop).toBe(startScroll);
  });
});
