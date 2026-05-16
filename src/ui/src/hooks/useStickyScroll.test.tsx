// @vitest-environment happy-dom

import { act, useEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStickyScroll } from "./useStickyScroll";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];
let rafCallbacks: FrameRequestCallback[] = [];

type StickyScrollApi = ReturnType<typeof useStickyScroll>;

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

function configureScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop?: number; scrollHeight: number; clientHeight: number },
) {
  const target = el as HTMLElement & {
    _clientHeight?: number;
    _stickyMetricsConfigured?: boolean;
    _scrollHeight?: number;
    _scrollTop?: number;
  };
  target._stickyMetricsConfigured = true;
  target._scrollHeight = metrics.scrollHeight;
  target._clientHeight = metrics.clientHeight;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => target._scrollTop ?? 0,
    set: (value: number) => {
      target._scrollTop = value;
    },
  });
  if (metrics.scrollTop != null) el.scrollTop = metrics.scrollTop;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => target._scrollHeight ?? 0,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => target._clientHeight ?? 0,
  });
}

function setScrollHeight(el: HTMLElement, scrollHeight: number) {
  (el as HTMLElement & { _scrollHeight?: number })._scrollHeight = scrollHeight;
}

function flushAnimationFrames() {
  const callbacks = rafCallbacks.splice(0);
  callbacks.forEach((cb) => cb(0));
}

function installDomObservers() {
  rafCallbacks = [];
  globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
    return {
      observe: () => undefined,
      unobserve: () => undefined,
      disconnect: () => undefined,
    };
  }) as unknown as typeof globalThis.ResizeObserver;
  globalThis.MutationObserver = vi.fn().mockImplementation(function () {
    return {
      observe: () => undefined,
      disconnect: () => undefined,
      takeRecords: () => [],
    };
  }) as unknown as typeof globalThis.MutationObserver;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  }) as typeof globalThis.requestAnimationFrame;
}

function Harness({
  metrics,
  onReady,
}: {
  metrics: { scrollTop?: number; scrollHeight: number; clientHeight: number };
  onReady: (api: StickyScrollApi, el: HTMLDivElement) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stickyScroll = useStickyScroll(ref);
  useEffect(() => {
    if (ref.current) onReady(stickyScroll, ref.current);
  }, [onReady, stickyScroll]);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (
          el &&
          !(el as HTMLElement & { _stickyMetricsConfigured?: boolean })
            ._stickyMetricsConfigured
        ) {
          configureScrollMetrics(el, metrics);
        }
      }}
    />
  );
}

beforeEach(() => {
  installDomObservers();
});

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

describe("useStickyScroll", () => {
  it("restores a saved chat scroll position without snapping to bottom", async () => {
    let api!: StickyScrollApi;
    let target!: HTMLDivElement;
    await render(
      <Harness
        metrics={{ scrollHeight: 1000, clientHeight: 400 }}
        onReady={(nextApi, nextTarget) => {
          api = nextApi;
          target = nextTarget;
        }}
      />,
    );

    await act(async () => {
      api.restoreScrollPosition(250);
    });

    expect(target.scrollTop).toBe(250);
    expect(api.isAtBottom).toBe(false);
  });

  it("clamps restored positions to the available scroll range", async () => {
    let api!: StickyScrollApi;
    let target!: HTMLDivElement;
    await render(
      <Harness
        metrics={{ scrollHeight: 1000, clientHeight: 400 }}
        onReady={(nextApi, nextTarget) => {
          api = nextApi;
          target = nextTarget;
        }}
      />,
    );

    await act(async () => {
      api.restoreScrollPosition(5000);
    });

    expect(target.scrollTop).toBe(600);
    expect(api.isAtBottom).toBe(true);
  });

  it("keeps following bottom when inline live tool content grows before the scheduled frame", async () => {
    let api!: StickyScrollApi;
    let target!: HTMLDivElement;
    await render(
      <Harness
        metrics={{ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }}
        onReady={(nextApi, nextTarget) => {
          api = nextApi;
          target = nextTarget;
        }}
      />,
    );

    await act(async () => {
      api.handleContentChanged();
      setScrollHeight(target, 1200);
      target.dispatchEvent(new Event("scroll"));
      flushAnimationFrames();
    });

    expect(target.scrollTop).toBe(1200);
    expect(api.isAtBottom).toBe(true);
  });

  it("does not force bottom when the user scrolls up during a pending live tool update", async () => {
    let api!: StickyScrollApi;
    let target!: HTMLDivElement;
    await render(
      <Harness
        metrics={{ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }}
        onReady={(nextApi, nextTarget) => {
          api = nextApi;
          target = nextTarget;
        }}
      />,
    );

    await act(async () => {
      api.handleContentChanged();
      setScrollHeight(target, 1200);
      target.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      target.scrollTop = 500;
      target.dispatchEvent(new Event("scroll"));
      flushAnimationFrames();
    });

    expect(target.scrollTop).toBe(500);
    expect(api.isAtBottom).toBe(false);
  });

  it("does not force bottom when the overlay scrollbar marks user intent", async () => {
    let api!: StickyScrollApi;
    let target!: HTMLDivElement;
    await render(
      <Harness
        metrics={{ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }}
        onReady={(nextApi, nextTarget) => {
          api = nextApi;
          target = nextTarget;
        }}
      />,
    );

    await act(async () => {
      api.handleContentChanged();
      setScrollHeight(target, 1200);
      api.markUserScrollIntent();
      target.scrollTop = 500;
      target.dispatchEvent(new Event("scroll"));
      flushAnimationFrames();
    });

    expect(target.scrollTop).toBe(500);
    expect(api.isAtBottom).toBe(false);
  });
});
