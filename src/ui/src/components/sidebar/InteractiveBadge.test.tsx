import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import {
  InteractiveBadge,
  computeInteractiveBadgeState,
} from "./InteractiveBadge";
import type { InteractiveSessionRow } from "../../services/interactive";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<InteractiveSessionRow> = {}): InteractiveSessionRow {
  return {
    sid: "sid-1",
    workspaceId: "ws-1",
    hostKind: "tmux",
    state: "running",
    crashReason: null,
    createdAt: "2026-05-16T12:00:00Z",
    lastAttachedAt: null,
    lastScreenBlob: null,
    claudeFlagsJson: "{}",
    pid: 1234,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InteractiveBadge (presentation)
// ---------------------------------------------------------------------------

describe("InteractiveBadge", () => {
  it("renders the awaiting state with the default label and badge-ask token", () => {
    const html = renderToString(<InteractiveBadge state="awaiting" />);
    expect(html).toContain("Awaiting input");
    expect(html).toContain('data-interactive-badge-state="awaiting"');
    expect(html).toContain("var(--badge-ask)");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Awaiting input"');
    expect(html).toContain('title="Awaiting input"');
  });

  it("renders the detached state with the default label and text-dim token", () => {
    const html = renderToString(<InteractiveBadge state="detached" />);
    expect(html).toContain("Detached");
    expect(html).toContain('data-interactive-badge-state="detached"');
    expect(html).toContain("var(--text-dim)");
  });

  it("renders the crashed state with the default label and status-stopped token", () => {
    const html = renderToString(<InteractiveBadge state="crashed" />);
    expect(html).toContain("Crashed");
    expect(html).toContain('data-interactive-badge-state="crashed"');
    expect(html).toContain("var(--status-stopped)");
  });

  it("honors an override label for title, aria-label, and visible text", () => {
    const html = renderToString(
      <InteractiveBadge state="awaiting" label="En espera" />,
    );
    expect(html).toContain("En espera");
    expect(html).toContain('title="En espera"');
    expect(html).toContain('aria-label="En espera"');
    // The default label should NOT appear when overridden.
    expect(html).not.toContain("Awaiting input");
  });

  it("passes through a className prop", () => {
    const html = renderToString(
      <InteractiveBadge state="detached" className="my-extra-class" />,
    );
    expect(html).toContain('class="my-extra-class"');
  });

  it("uses a different data-state attribute per state value", () => {
    const a = renderToString(<InteractiveBadge state="awaiting" />);
    const b = renderToString(<InteractiveBadge state="detached" />);
    const c = renderToString(<InteractiveBadge state="crashed" />);
    expect(a).toContain('data-interactive-badge-state="awaiting"');
    expect(b).toContain('data-interactive-badge-state="detached"');
    expect(c).toContain('data-interactive-badge-state="crashed"');
  });
});

// ---------------------------------------------------------------------------
// computeInteractiveBadgeState (selector logic)
// ---------------------------------------------------------------------------

describe("computeInteractiveBadgeState", () => {
  it("returns null when there are no sessions and no live signal", () => {
    expect(computeInteractiveBadgeState([])).toBeNull();
    expect(computeInteractiveBadgeState(undefined)).toBeNull();
  });

  it("returns 'awaiting' when the assembler signals awaiting and no sessions are persisted", () => {
    expect(computeInteractiveBadgeState([], true)).toBe("awaiting");
    expect(computeInteractiveBadgeState(undefined, true)).toBe("awaiting");
  });

  it("returns 'detached' when at least one session is in DB state 'running'", () => {
    const rows = [makeRow({ state: "running" })];
    expect(computeInteractiveBadgeState(rows)).toBe("detached");
  });

  it("returns 'crashed' when any session is in DB state 'crashed' (highest precedence)", () => {
    const rows = [
      makeRow({ sid: "a", state: "running" }),
      makeRow({ sid: "b", state: "crashed" }),
    ];
    expect(computeInteractiveBadgeState(rows)).toBe("crashed");
  });

  it("returns 'crashed' even when assembler signals awaiting (crash wins)", () => {
    const rows = [makeRow({ state: "crashed" })];
    expect(computeInteractiveBadgeState(rows, true)).toBe("crashed");
  });

  it("returns 'awaiting' when assembler signals awaiting and only running rows exist", () => {
    const rows = [makeRow({ state: "running" })];
    expect(computeInteractiveBadgeState(rows, true)).toBe("awaiting");
  });

  it("returns null when only exited / unknown sessions are persisted", () => {
    const rows = [
      makeRow({ sid: "a", state: "exited" }),
      makeRow({ sid: "b", state: "unknown" }),
    ];
    expect(computeInteractiveBadgeState(rows)).toBeNull();
  });

  it("ignores non-running, non-crashed states when computing 'detached'", () => {
    const rows = [
      makeRow({ sid: "a", state: "exited" }),
      makeRow({ sid: "b", state: "running" }),
    ];
    expect(computeInteractiveBadgeState(rows)).toBe("detached");
  });
});
