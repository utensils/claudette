import { describe, expect, it } from "vitest";
import { __TEST__ } from "./useWorkspaceEnvironmentPreparation";

const { looksLikeTrustError, looksLikeMissingWorkspace } = __TEST__;

describe("looksLikeTrustError", () => {
  it("matches the legacy mise-not-trusted error string", () => {
    expect(
      looksLikeTrustError(
        "Environment setup needed: env-mise: export: Plugin script error: ... mise.toml are not trusted. Trust them with `mise trust`...",
      ),
    ).toBe(true);
  });

  it("matches direnv 'is blocked' phrasing", () => {
    expect(
      looksLikeTrustError(
        "Environment setup needed: env-direnv: direnv: error /repo/.envrc is blocked",
      ),
    ).toBe(true);
  });

  it("returns false for a generic mise parse error so its toast still fires", () => {
    expect(
      looksLikeTrustError(
        "Environment provider failed: env-mise: TOML parse error at line 4",
      ),
    ).toBe(false);
  });

  it("returns false for the empty string", () => {
    expect(looksLikeTrustError("")).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(looksLikeTrustError("FILE IS NOT TRUSTED")).toBe(true);
  });
});

describe("looksLikeMissingWorkspace", () => {
  it("matches the backend's 'Workspace not found' error verbatim", () => {
    // The exact string `resolve_target_from_db` returns in
    // `src-tauri/src/commands/env.rs` when the workspace id has no DB row.
    expect(looksLikeMissingWorkspace("Workspace not found")).toBe(true);
  });

  it("matches case-insensitively and when wrapped in other text", () => {
    expect(looksLikeMissingWorkspace("error: workspace not found")).toBe(true);
  });

  it("returns false for unrelated env-provider errors", () => {
    expect(
      looksLikeMissingWorkspace(
        "Environment provider failed: env-mise: TOML parse error",
      ),
    ).toBe(false);
  });

  it("does not match a generic 'not found' that isn't about the workspace", () => {
    expect(looksLikeMissingWorkspace("Repository not found")).toBe(false);
  });
});
