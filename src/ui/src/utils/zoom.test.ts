import { afterEach, describe, expect, it } from "vitest";
import {
  getRootZoom,
  viewportLayoutSize,
  viewportToFixed,
} from "./zoom";

// vitest runs in the Node environment by default, so we hand-roll a
// minimal `document.documentElement` and `window` surface that mirrors
// what the helpers actually touch. Same pattern as focusTargets.test.ts.

type GlobalShim = {
  document?: { documentElement: { style: { zoom: string } } };
  window?: { innerWidth: number; innerHeight: number };
};

function withRootZoom(zoom: string | undefined, fn: () => void) {
  const g = globalThis as unknown as GlobalShim;
  const prevDoc = g.document;
  g.document = {
    documentElement: { style: { zoom: zoom ?? "" } },
  };
  try {
    fn();
  } finally {
    g.document = prevDoc;
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

describe("viewportToFixed", () => {
  it("passes coords through unchanged at zoom=1", () => {
    withRootZoom("", () => {
      expect(viewportToFixed(120, 80)).toEqual({ x: 120, y: 80 });
    });
  });

  it("divides coords by the zoom factor so `position: fixed; left: x` lands at the cursor", () => {
    // WebKit on macOS reports event clientX/Y in visual pixels but
    // `position: fixed; left/top` interprets values as layout pixels —
    // so visual / zoom = layout for a fixed element to render at the
    // visual click point.
    withRootZoom("1.5", () => {
      const { x, y } = viewportToFixed(300, 150);
      expect(x).toBeCloseTo(200, 6);
      expect(y).toBeCloseTo(100, 6);
    });
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

  it("converts visual viewport size into layout pixels under zoom", () => {
    // Same frame as `viewportToFixed`: layout = visual / zoom. Clamping
    // a fixed-positioned element wants layout-pixel bounds, not visual.
    withRootZoom("1.5", () => {
      withViewport(1920, 1080, () => {
        const { width, height } = viewportLayoutSize();
        expect(width).toBeCloseTo(1280, 6);
        expect(height).toBeCloseTo(720, 6);
      });
    });
  });
});
