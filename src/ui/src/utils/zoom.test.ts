import { afterEach, describe, expect, it } from "vitest";
import {
  eventCoordSpace,
  getRootZoom,
  resetCoordSpaceCache,
  viewportLayoutSize,
  viewportToFixed,
} from "./zoom";

// vitest runs in the Node environment by default, so we hand-roll a
// minimal `document.documentElement` and `window` surface that mirrors
// what the helpers actually touch. Same pattern as focusTargets.test.ts.

type ProbeNode = {
  style: { cssText: string };
  getBoundingClientRect?: () => { left: number };
};

type GlobalShim = {
  document?: {
    documentElement: { style: { zoom: string } };
    body?: {
      appendChild: (node: ProbeNode) => void;
      removeChild: (node: ProbeNode) => void;
    };
    createElement?: (tag: string) => ProbeNode;
  };
  window?: { innerWidth: number; innerHeight: number };
};

interface RootOpts {
  // When set, attach a fake `body` + `createElement` so the engine probe
  // can run. The factory receives the cssText that the probe assigned to
  // the element and returns the `rect.left` it should report — this is
  // how each test simulates a particular engine.
  probeRectLeft?: (cssText: string) => number;
}

function withRootZoom(
  zoom: string | undefined,
  fn: () => void,
  opts: RootOpts = {},
) {
  const g = globalThis as unknown as GlobalShim;
  const prevDoc = g.document;
  const doc: NonNullable<GlobalShim["document"]> = {
    documentElement: { style: { zoom: zoom ?? "" } },
  };
  if (opts.probeRectLeft) {
    const rectFor = opts.probeRectLeft;
    doc.createElement = () => {
      const node: ProbeNode = { style: { cssText: "" } };
      node.getBoundingClientRect = () => ({ left: rectFor(node.style.cssText) });
      return node;
    };
    doc.body = {
      appendChild: () => {},
      removeChild: () => {},
    };
  }
  g.document = doc;
  // The probe answer is cached at module scope to avoid re-measuring on
  // every menu open. Reset between tests so each one exercises the branch
  // it intends to.
  resetCoordSpaceCache();
  try {
    fn();
  } finally {
    g.document = prevDoc;
    resetCoordSpaceCache();
  }
}

function withViewport(width: number, height: number, fn: () => void) {
  const g = globalThis as unknown as GlobalShim;
  const prevWin = g.window;
  g.window = { innerWidth: width, innerHeight: height };
  try {
    fn();
  } finally {
    g.window = prevWin;
  }
}

afterEach(() => {
  // Defensive: tests may early-return; ensure we don't leak document/window
  // state into the next test.
  const g = globalThis as unknown as GlobalShim;
  delete g.document;
  delete g.window;
  resetCoordSpaceCache();
});

describe("getRootZoom", () => {
  it("returns 1 when zoom is unset", () => {
    withRootZoom("", () => {
      expect(getRootZoom()).toBe(1);
    });
  });

  it("returns 1 when zoom parses as NaN", () => {
    withRootZoom("not-a-number", () => {
      expect(getRootZoom()).toBe(1);
    });
  });

  it("returns 1 when zoom is zero or negative (defensive)", () => {
    withRootZoom("0", () => {
      expect(getRootZoom()).toBe(1);
    });
    withRootZoom("-1.5", () => {
      expect(getRootZoom()).toBe(1);
    });
  });

  it("parses the zoom factor when set as a unitless number", () => {
    withRootZoom("1.153846", () => {
      expect(getRootZoom()).toBeCloseTo(1.153846, 6);
    });
  });
});

describe("eventCoordSpace", () => {
  // The probe places a fixed-positioned 100px-wide marker and reads back
  // its rect.left. WebKit reports rect.left ≈ 100 * zoom (the rect is in
  // the visual frame); Chromium reports rect.left ≈ 100 (layout frame).
  it("detects WebKit when the rect is reported in the visual frame", () => {
    withRootZoom(
      "1.5",
      () => {
        expect(eventCoordSpace()).toBe("visual");
      },
      { probeRectLeft: () => 150 },
    );
  });

  it("detects Chromium when the rect is reported in the layout frame", () => {
    withRootZoom(
      "1.5",
      () => {
        expect(eventCoordSpace()).toBe("layout");
      },
      { probeRectLeft: () => 100 },
    );
  });

  it("falls back to 'visual' when there's no DOM to probe", () => {
    // No probeRectLeft → no body / createElement, mirroring the SSR / very
    // early bootstrap window before <body> is attached.
    withRootZoom("1.5", () => {
      expect(eventCoordSpace()).toBe("visual");
    });
  });

  it("does not cache the no-DOM fallback so a later real probe wins", () => {
    // Codex review caught this: if the first call happened during boot
    // before document.body existed, the old cache logic locked in
    // 'visual' even on Chromium. After the fix, the fallback is
    // returned but NOT cached, so the next call with real DOM gets the
    // real engine answer.
    withRootZoom("1.5", () => {
      // First call: no DOM → returns "visual" (default), should not cache.
      expect(eventCoordSpace()).toBe("visual");
    });
    // New shim with Chromium-style rect, same session.
    withRootZoom(
      "1.5",
      () => {
        expect(eventCoordSpace()).toBe("layout");
      },
      { probeRectLeft: () => 100 },
    );
  });
});

describe("viewportToFixed", () => {
  it("passes coords through unchanged at zoom=1", () => {
    withRootZoom("", () => {
      expect(viewportToFixed(120, 80)).toEqual({ x: 120, y: 80 });
    });
  });

  it("divides coords by zoom on WebKit (event clientX is visual px)", () => {
    // WebKit reports clientX/Y in visual pixels but `position: fixed;
    // left/top` interpret values in layout pixels — so visual / zoom =
    // layout for the fixed element to render at the visual click point.
    withRootZoom(
      "1.5",
      () => {
        const { x, y } = viewportToFixed(300, 150);
        expect(x).toBeCloseTo(200, 6);
        expect(y).toBeCloseTo(100, 6);
      },
      { probeRectLeft: () => 150 },
    );
  });

  it("passes coords through on Chromium (event clientX is already layout px)", () => {
    // Chromium applies zoom uniformly: event coords, rects, and the fixed
    // used-value all share one frame. Dividing here would over-correct and
    // shift the element toward the top-left — which is the offset that
    // Windows devs reported before this branch existed.
    withRootZoom(
      "1.5",
      () => {
        expect(viewportToFixed(300, 150)).toEqual({ x: 300, y: 150 });
      },
      { probeRectLeft: () => 100 },
    );
  });
});

describe("viewportLayoutSize", () => {
  it("returns innerWidth/innerHeight verbatim at zoom=1", () => {
    withRootZoom("", () => {
      withViewport(1920, 1080, () => {
        expect(viewportLayoutSize()).toEqual({ width: 1920, height: 1080 });
      });
    });
  });

  it("converts visual viewport size into layout pixels under WebKit zoom", () => {
    // Same frame as `viewportToFixed`: layout = visual / zoom. Clamping
    // a fixed-positioned element wants layout-pixel bounds, not visual.
    withRootZoom(
      "1.5",
      () => {
        withViewport(1920, 1080, () => {
          const { width, height } = viewportLayoutSize();
          expect(width).toBeCloseTo(1280, 6);
          expect(height).toBeCloseTo(720, 6);
        });
      },
      { probeRectLeft: () => 150 },
    );
  });

  it("returns innerWidth/innerHeight verbatim under Chromium zoom", () => {
    // Chromium's innerWidth/Height already live in the layout frame, so
    // dividing would shrink the clamp bounds and let the menu drift off
    // the right/bottom edges.
    withRootZoom(
      "1.5",
      () => {
        withViewport(1920, 1080, () => {
          expect(viewportLayoutSize()).toEqual({ width: 1920, height: 1080 });
        });
      },
      { probeRectLeft: () => 100 },
    );
  });
});
