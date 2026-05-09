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
//   5. Drag mapping: a pointermove delta translates into the right
//      scrollTop delta (inverse of slider/content ratio), with
//      clamping at both ends.
//   6. Observer + listener cleanup on unmount, so component churn
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
 *  inside the target — both are easier to drive by hand. */
type Capture = {
  resizeCallback: ResizeObserverCallback | null;
  mutationCallback: MutationCallback | null;
  resizeDisconnectCount: number;
  mutationDisconnectCount: number;
};

function installObserverCaptures(): Capture {
  const cap: Capture = {
    resizeCallback: null,
    mutationCallback: null,
    resizeDisconnectCount: 0,
    mutationDisconnectCount: 0,
  };
  const RO = vi
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
    });
  const MO = vi.fn().mockImplementation(function (cb: MutationCallback) {
    cap.mutationCallback = cb;
    return {
      observe: () => undefined,
      disconnect: () => {
        cap.mutationDisconnectCount += 1;
      },
      takeRecords: () => [],
    };
  });
  // happy-dom defines these globally; reassign so the component picks up
  // the stub when it constructs new observers in its effect.
  globalThis.ResizeObserver =
    RO as unknown as typeof globalThis.ResizeObserver;
  globalThis.MutationObserver =
    MO as unknown as typeof globalThis.MutationObserver;
  return cap;
}

/**
 * Test harness that mounts the component against a real <div> the test
 * can resize via `configureScrollMetrics`. Returns the slider, track,
 * and the target element so each case can drive scrollTop directly.
 */
function Harness({
  metrics,
  onTargetReady,
}: {
  metrics: { scrollTop?: number; scrollHeight: number; clientHeight: number };
  onTargetReady?: (el: HTMLDivElement) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div data-testid="wrapper" style={{ position: "relative" }}>
      <div
        data-testid="target"
        ref={(el) => {
          ref.current = el;
          if (el) {
            configureScrollMetrics(el, metrics);
            onTargetReady?.(el);
          }
        }}
      />
      <OverlayScrollbar targetRef={ref} />
    </div>
  );
}

describe("OverlayScrollbar", () => {
  let capture: Capture;
  beforeEach(() => {
    capture = installObserverCaptures();
  });

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
    await act(async () => {
      target.scrollTop = 600;
      target.dispatchEvent(new Event("scroll"));
    });
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
    await act(async () => {
      configureScrollMetrics(target, { scrollHeight: 1000, clientHeight: 800 });
      capture.resizeCallback!(
        [] as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      );
    });
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
    await act(async () => {
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
    });
    // 400 * (400 / 2000) = 80px.
    expect(slider.style.height).toBe("80px");
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
  beforeEach(() => {
    installObserverCaptures();
  });

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
});
