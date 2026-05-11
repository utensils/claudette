import { describe, expect, it } from "vitest";
import {
  allRowsResolved,
  classifyPostActionError,
  isEnvTrustModalData,
} from "./EnvTrustModal";

describe("allRowsResolved", () => {
  const plugins = [{ plugin_name: "env-mise" }, { plugin_name: "env-direnv" }];

  it("returns false when no rows have transitioned", () => {
    expect(allRowsResolved(plugins, {})).toBe(false);
  });

  it("returns false when only one of two rows is resolved", () => {
    expect(
      allRowsResolved(plugins, { "env-mise": { kind: "trusted" } }),
    ).toBe(false);
  });

  it("returns false while a row is in-flight (trusting / disabling)", () => {
    expect(
      allRowsResolved(plugins, {
        "env-mise": { kind: "trusted" },
        "env-direnv": { kind: "trusting" },
      }),
    ).toBe(false);
  });

  it("returns false when a row has failed (user should be able to retry)", () => {
    // Regression: failed must NOT auto-close — the user needs to see
    // the error and click again. Auto-closing would hide the failure.
    expect(
      allRowsResolved(plugins, {
        "env-mise": { kind: "trusted" },
        "env-direnv": { kind: "failed" },
      }),
    ).toBe(false);
  });

  it("returns true when every row is trusted", () => {
    expect(
      allRowsResolved(plugins, {
        "env-mise": { kind: "trusted" },
        "env-direnv": { kind: "trusted" },
      }),
    ).toBe(true);
  });

  it("returns true when every row is disabled", () => {
    expect(
      allRowsResolved(plugins, {
        "env-mise": { kind: "disabled" },
        "env-direnv": { kind: "disabled" },
      }),
    ).toBe(true);
  });

  it("returns true with a mix of trusted + disabled across rows", () => {
    expect(
      allRowsResolved(plugins, {
        "env-mise": { kind: "trusted" },
        "env-direnv": { kind: "disabled" },
      }),
    ).toBe(true);
  });

  it("returns false for an empty plugin list — nothing to auto-close on", () => {
    // The backend never sends an empty trust event (the listener guards
    // for it too), but be defensive: an empty list shouldn't trigger
    // auto-close because the modal would close instantly on open.
    expect(allRowsResolved([], {})).toBe(false);
  });
});

describe("isEnvTrustModalData", () => {
  const minimal = {
    workspace_id: "ws-1",
    repo_id: "repo-1",
    plugins: [{ plugin_name: "env-mise", error_excerpt: "..." }],
  };

  it("accepts a minimal payload from a backwards-compatible build", () => {
    expect(isEnvTrustModalData(minimal)).toBe(true);
  });

  it("accepts the full new-shape payload (message + config_path present)", () => {
    expect(
      isEnvTrustModalData({
        ...minimal,
        plugins: [
          {
            plugin_name: "env-mise",
            message: "mise.toml is not trusted.",
            config_path: "/repo/mise.toml",
            error_excerpt: "raw stderr",
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects null", () => {
    expect(isEnvTrustModalData(null)).toBe(false);
  });

  it("rejects when workspace_id is missing", () => {
    expect(
      isEnvTrustModalData({ repo_id: "r", plugins: minimal.plugins }),
    ).toBe(false);
  });

  it("rejects when plugins is not an array", () => {
    expect(isEnvTrustModalData({ ...minimal, plugins: "oops" })).toBe(false);
  });

  it("rejects when a plugin entry is missing plugin_name", () => {
    expect(
      isEnvTrustModalData({
        ...minimal,
        plugins: [{ error_excerpt: "..." }],
      }),
    ).toBe(false);
  });

  it("rejects when config_path is the wrong type", () => {
    // config_path is allowed to be missing or null, but if present
    // must be a string. Numbers / objects must be rejected so a
    // malformed event payload doesn't render `{}` as the path.
    expect(
      isEnvTrustModalData({
        ...minimal,
        plugins: [
          {
            plugin_name: "env-mise",
            error_excerpt: "...",
            config_path: 12345,
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("classifyPostActionError — Codex P2 regression guard", () => {
  // After a Trust/Disable action the modal re-queries getEnvSources
  // and routes the matching row through this classifier. The bug
  // codex caught: if the underlying trust command silently no-op'd,
  // `prepare_workspace_environment` now returns Ok(()) (trust errors
  // route through the event), so the old code marked the row trusted
  // and auto-closed the modal on a still-blocked workspace.

  it("treats an absent source as cleared (Disable hid it from the dispatcher)", () => {
    expect(classifyPostActionError(undefined)).toEqual({ kind: "cleared" });
  });

  it("treats a source with no error as cleared (trust took effect)", () => {
    expect(classifyPostActionError({ error: null })).toEqual({
      kind: "cleared",
    });
  });

  it("reports still-blocked for a 'not trusted' mise error", () => {
    expect(
      classifyPostActionError({ error: "mise.toml is not trusted." }),
    ).toEqual({ kind: "still-blocked", error: "mise.toml is not trusted." });
  });

  it("reports still-blocked for a 'is blocked' direnv error", () => {
    expect(
      classifyPostActionError({
        error: "direnv: error /repo/.envrc is blocked.",
      }),
    ).toEqual({
      kind: "still-blocked",
      error: "direnv: error /repo/.envrc is blocked.",
    });
  });

  it("matches case-insensitively (mirrors Rust is_trust_error_str)", () => {
    expect(
      classifyPostActionError({ error: "FILE IS UNTRUSTED" }),
    ).toEqual({ kind: "still-blocked", error: "FILE IS UNTRUSTED" });
  });

  it("treats a non-trust error as cleared (EnvPanel surfaces those)", () => {
    // The modal is the wrong surface for broken TOML / parse errors;
    // leaving the row green here lets the EnvPanel error card take
    // over instead of double-prompting via the modal.
    expect(
      classifyPostActionError({
        error: "TOML parse error at line 4",
      }),
    ).toEqual({ kind: "cleared" });
  });
});
