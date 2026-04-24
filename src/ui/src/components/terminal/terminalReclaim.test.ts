import { describe, expect, it } from "vitest";
import { reclaimScrollLines } from "./terminalReclaim";

describe("reclaimScrollLines", () => {
  it("scrolls up so the cursor lands near the bottom of the viewport", () => {
    // The exact case seen when zsh+starship clears the viewport on SIGWINCH:
    // cursor was at y=18 (bottom of 19-row viewport) pre-split; post-split
    // the shell emitted `\e[H\e[J`, cursor now at y=2 with 51 rows of
    // scrollback available above.
    expect(reclaimScrollLines({ rows: 19, cursorY: 2, baseY: 51 })).toBe(-16);
  });

  it("does nothing when the cursor is already in the lower half", () => {
    // User hasn't lost visible context — don't steal their scroll position.
    expect(reclaimScrollLines({ rows: 20, cursorY: 10, baseY: 100 })).toBe(0);
    expect(reclaimScrollLines({ rows: 20, cursorY: 19, baseY: 100 })).toBe(0);
  });

  it("does nothing when there is no scrollback to reveal", () => {
    expect(reclaimScrollLines({ rows: 19, cursorY: 2, baseY: 0 })).toBe(0);
  });

  it("caps the scroll by the available scrollback", () => {
    // Only 3 lines of history exist; we can't scroll up 16.
    expect(reclaimScrollLines({ rows: 19, cursorY: 2, baseY: 3 })).toBe(-3);
  });

  it("is a no-op on degenerate viewport sizes", () => {
    expect(reclaimScrollLines({ rows: 0, cursorY: 0, baseY: 10 })).toBe(0);
    expect(reclaimScrollLines({ rows: 1, cursorY: 0, baseY: 10 })).toBe(0);
  });
});
