import { describe, expect, it } from "vitest";
import type { ClaudeFlagDef, FlagValue } from "../../services/claudeFlags";
import {
  hasDangerousFlag,
  resolveEnabledExtraFlags,
  type ResolvedFlag,
} from "./workspaceClaudeFlagsSlice";

const def = (overrides: Partial<ClaudeFlagDef>): ClaudeFlagDef => ({
  name: "--debug",
  short: null,
  takes_value: false,
  value_placeholder: null,
  enum_choices: null,
  description: "Enable debug output",
  is_dangerous: false,
  ...overrides,
});

const fv = (enabled: boolean, value: string | null = null): FlagValue => ({
  enabled,
  value,
});

describe("resolveEnabledExtraFlags", () => {
  it("returns empty when no defs", () => {
    expect(resolveEnabledExtraFlags([], {}, {})).toEqual([]);
  });

  it("uses global state when no repo override", () => {
    const defs = [def({ name: "--debug" })];
    expect(
      resolveEnabledExtraFlags(defs, { "--debug": fv(true) }, {}),
    ).toEqual<ResolvedFlag[]>([
      { name: "--debug", value: undefined, isDangerous: false },
    ]);
  });

  it("repo override wins over global", () => {
    const defs = [def({ name: "--debug" })];
    expect(
      resolveEnabledExtraFlags(
        defs,
        { "--debug": fv(true) },
        { "--debug": fv(false) },
      ),
    ).toEqual([]);
  });

  it("excludes disabled flags", () => {
    const defs = [def({ name: "--debug" })];
    expect(
      resolveEnabledExtraFlags(defs, { "--debug": fv(false) }, {}),
    ).toEqual([]);
  });

  it("emits value for value-taking flag, undefined for boolean", () => {
    const defs = [
      def({ name: "--add-dir", takes_value: true }),
      def({ name: "--debug" }),
    ];
    expect(
      resolveEnabledExtraFlags(
        defs,
        { "--add-dir": fv(true, "/foo"), "--debug": fv(true) },
        {},
      ),
    ).toEqual<ResolvedFlag[]>([
      { name: "--add-dir", value: "/foo", isDangerous: false },
      { name: "--debug", value: undefined, isDangerous: false },
    ]);
  });

  it("treats null value on value-taking flag as empty string", () => {
    const defs = [def({ name: "--add-dir", takes_value: true })];
    const result = resolveEnabledExtraFlags(
      defs,
      { "--add-dir": fv(true, null) },
      {},
    );
    expect(result[0]?.value).toBe("");
  });

  it("propagates is_dangerous from def", () => {
    const defs = [
      def({ name: "--dangerously-skip-permissions", is_dangerous: true }),
    ];
    const result = resolveEnabledExtraFlags(
      defs,
      { "--dangerously-skip-permissions": fv(true) },
      {},
    );
    expect(result[0]?.isDangerous).toBe(true);
  });

  it("ignores defs with no state in either map", () => {
    expect(resolveEnabledExtraFlags([def({ name: "--debug" })], {}, {})).toEqual([]);
  });
});

describe("hasDangerousFlag", () => {
  it("returns true when --dangerously-skip-permissions present", () => {
    expect(
      hasDangerousFlag([
        { name: "--dangerously-skip-permissions", value: undefined, isDangerous: true },
      ]),
    ).toBe(true);
  });

  it("returns false on empty list", () => {
    expect(hasDangerousFlag([])).toBe(false);
  });

  it("returns false when only other flags present", () => {
    expect(
      hasDangerousFlag([
        { name: "--debug", value: undefined, isDangerous: false },
      ]),
    ).toBe(false);
  });

  it("matches by literal name (not isDangerous flag)", () => {
    // Per spec: badge fires only on the literal --dangerously-skip-permissions
    // name. A future --dangerously-foo with isDangerous=true should not trigger.
    expect(
      hasDangerousFlag([
        { name: "--dangerously-foo", value: undefined, isDangerous: true },
      ]),
    ).toBe(false);
  });
});
