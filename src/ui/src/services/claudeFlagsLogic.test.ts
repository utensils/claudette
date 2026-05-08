import { describe, expect, it } from "vitest";
import {
  isStillLoading,
  resolveEnabledExtraFlags,
  type ResolvedFlag,
} from "./claudeFlagsLogic";
import type { ClaudeFlagDef } from "./claudeFlags";

describe("isStillLoading", () => {
  it("matches the literal Tauri-side loading message", () => {
    expect(isStillLoading(new Error("CLI flags still loading…"))).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isStillLoading(new Error("CLI Flags STILL LOADING"))).toBe(true);
  });

  it("returns false for unrelated Error instances", () => {
    expect(isStillLoading(new Error("connection refused"))).toBe(false);
    expect(isStillLoading(new Error("`claude` not found on PATH"))).toBe(false);
  });

  it("returns false for null / undefined / non-Error rejections", () => {
    expect(isStillLoading(null)).toBe(false);
    expect(isStillLoading(undefined)).toBe(false);
    expect(isStillLoading("CLI flags still loading…")).toBe(false);
    expect(isStillLoading({ message: "still loading" })).toBe(false);
  });
});

describe("resolveEnabledExtraFlags value-recovery edge", () => {
  it("emits empty-string value when value-taking flag has null stored value", () => {
    const defs: ClaudeFlagDef[] = [
      {
        name: "--add-dir",
        short: null,
        takes_value: true,
        value_placeholder: "directories",
        enum_choices: null,
        description: "",
        is_dangerous: false,
      },
    ];
    const global = {
      "--add-dir": { enabled: true, value: null },
    };
    const result: ResolvedFlag[] = resolveEnabledExtraFlags(defs, global, {});
    expect(result).toEqual([
      { name: "--add-dir", value: "", isDangerous: false },
    ]);
  });
});
