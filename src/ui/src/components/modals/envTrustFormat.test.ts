import { describe, expect, it } from "vitest";
import { formatElapsed, summarizeError } from "./envTrustFormat";

describe("summarizeError — regression coverage for the modal-cleaner pipeline", () => {
  // The proactive-from-Settings path (EnvPanel toggle-on / Resolve…)
  // synthesizes the modal's `message` from raw resolver output. The
  // event-driven path runs through Rust's `clean_trust_error_excerpt`
  // chain in src-tauri/src/commands/env.rs. These cases pin the
  // strip-order so the two paths agree on what the user sees.

  it("returns clean inputs unchanged", () => {
    expect(summarizeError("mise.toml is not trusted.")).toBe(
      "mise.toml is not trusted.",
    );
  });

  it("strips ANSI SGR escape codes (direnv tints + reset)", () => {
    // Regression: the very first UAT screenshot showed the dialog
    // body ending with `…approve its content[0m` because
    // direnv's `is blocked` message is wrapped in red SGR escape
    // codes that leaked through to the modal.
    const ansi = "[31mdirenv: error /repo/.envrc is blocked[0m";
    expect(summarizeError(ansi)).toBe("direnv: error /repo/.envrc is blocked");
  });

  it("strips multi-segment ANSI sequences (foreground + bold + reset)", () => {
    expect(summarizeError("[1;31mboom[22;39m done")).toBe(
      "boom done",
    );
  });

  it("strips the dispatcher 'export:' prefix", () => {
    expect(summarizeError("export: oh no")).toBe("oh no");
  });

  it("strips the mlua wrapper line", () => {
    expect(
      summarizeError(
        "Plugin script error: runtime error: mise.toml is not trusted.",
      ),
    ).toBe("mise.toml is not trusted.");
  });

  it("strips the Lua call-site location anywhere in the prefix", () => {
    expect(
      summarizeError(
        '[string "plugins/env-direnv/init.lua"]:64: direnv: blocked',
      ),
    ).toBe("direnv: blocked");
  });

  it("strips all four wrapper layers in the realistic UAT order", () => {
    // The exact shape from the first reported UAT failure: dispatcher
    // prefix, mlua wrapper, Lua location, then the actual one-liner
    // surfaced by our tightened env-direnv plugin, plus a trailing
    // ANSI reset. Mirrors what the resolver returned before the
    // proactive Settings path was wired up.
    const raw =
      "export: Plugin script error: runtime error: " +
      '[string "plugins/env-direnv/init.lua"]:64: ' +
      "direnv: error /Users/jamesbrink/Projects/quantierra/nyc-real-estate/.envrc is blocked. " +
      "Run `direnv allow` to approve its content[0m";
    expect(summarizeError(raw)).toBe(
      "direnv: error /Users/jamesbrink/Projects/quantierra/nyc-real-estate/.envrc is blocked. Run `direnv allow` to approve its content",
    );
  });

  it("takes only the first line of multi-line errors", () => {
    expect(
      summarizeError(
        "mise.toml is not trusted.\nstack traceback:\n  [string \"...\"]:1: in main chunk",
      ),
    ).toBe("mise.toml is not trusted.");
  });

  it("truncates very long lines to 240 chars", () => {
    const long = "x".repeat(500);
    expect(summarizeError(long)).toHaveLength(240);
  });

  it("is case-insensitive on the mlua wrapper (Plugin Script Error vs plugin script error)", () => {
    expect(
      summarizeError("PLUGIN SCRIPT ERROR: RUNTIME ERROR: nope"),
    ).toBe("nope");
  });

  it("handles a wrapper-only input (no inner message) without throwing", () => {
    // Defensive: a malformed event payload shouldn't crash the modal.
    // We return an empty string rather than the literal prefix so the
    // modal's `message ?? action_failed` fallback can take over.
    expect(summarizeError("export: ")).toBe("");
  });
});

describe("formatElapsed — regression coverage for the in-flight button counter", () => {
  // Translation strings use the {{seconds}} placeholder verbatim and
  // must NOT append another `s` (we shipped that bug as `Trusting…
  // 5ss` in UAT). The unit is baked into the return value here.

  it("returns 0s immediately after start", () => {
    expect(formatElapsed(1000, 1000)).toBe("0s");
  });

  it("returns Ns for sub-minute durations", () => {
    expect(formatElapsed(1000, 5000)).toBe("4s");
    expect(formatElapsed(0, 30_000)).toBe("30s");
    expect(formatElapsed(0, 59_999)).toBe("59s");
  });

  it("returns 'Nm Ms' at and past one minute", () => {
    expect(formatElapsed(0, 60_000)).toBe("1m 0s");
    expect(formatElapsed(0, 83_000)).toBe("1m 23s");
    expect(formatElapsed(0, 3_661_000)).toBe("61m 1s");
  });

  it("clamps negative elapsed (clock skew, debug-time-travel) to 0s", () => {
    // No protection against the Date.now() argument being in the past
    // would make the button render "-5s" which is meaningless. Clamp
    // at 0 so the button never goes weird.
    expect(formatElapsed(10_000, 5_000)).toBe("0s");
  });

  it("never appends a stray 's' to a value that already includes 's'", () => {
    // Direct regression on the UAT-caught "Trusting… 5ss" bug. If
    // this assertion fails it's almost certainly because a translation
    // change re-added the trailing `s` to {{seconds}}.
    expect(formatElapsed(0, 5_000).endsWith("ss")).toBe(false);
    expect(formatElapsed(0, 70_000).endsWith("ss")).toBe(false);
  });
});
