import { describe, expect, it } from "vitest";
import type {
  ClaudeFlagDef,
  FlagStateResponse,
} from "../../../services/claudeFlags";
import { rowStateFor, sortFlags } from "./claudeFlagsLogic";

// The ClaudeFlagsSettings component is async data flow + JSX. The two pieces
// of business logic worth pinning down — flag ordering and per-row state
// resolution (global fallback vs repo override) — are extracted as pure
// helpers so they can be tested without a DOM harness.

function makeDef(overrides: Partial<ClaudeFlagDef> = {}): ClaudeFlagDef {
  return {
    name: "--debug",
    short: null,
    takes_value: false,
    value_placeholder: null,
    enum_choices: null,
    description: "",
    is_dangerous: false,
    ...overrides,
  };
}

describe("sortFlags", () => {
  it("returns flags in alphabetical order by name", () => {
    const defs = [
      makeDef({ name: "--zebra" }),
      makeDef({ name: "--apple" }),
      makeDef({ name: "--mango" }),
    ];
    expect(sortFlags(defs).map((d) => d.name)).toEqual([
      "--apple",
      "--mango",
      "--zebra",
    ]);
  });

  it("does not mutate the input array", () => {
    const defs = [
      makeDef({ name: "--zebra" }),
      makeDef({ name: "--apple" }),
    ];
    const before = defs.map((d) => d.name);
    sortFlags(defs);
    expect(defs.map((d) => d.name)).toEqual(before);
  });
});

describe("rowStateFor", () => {
  const def = makeDef({ name: "--debug", takes_value: true });

  it("falls back to global when at global scope", () => {
    const state: FlagStateResponse = {
      global: { "--debug": { enabled: true, value: "verbose" } },
      repo: {},
    };
    expect(rowStateFor(def, state, { kind: "global" })).toEqual({
      enabled: true,
      value: "verbose",
      isOverride: false,
    });
  });

  it("uses repo override when present at repo scope", () => {
    const state: FlagStateResponse = {
      global: { "--debug": { enabled: true, value: "global-value" } },
      repo: { "--debug": { enabled: false, value: "repo-value" } },
    };
    expect(
      rowStateFor(def, state, { kind: "repo", repoId: "r1" }),
    ).toEqual({
      enabled: false,
      value: "repo-value",
      isOverride: true,
    });
  });

  it("inherits from global at repo scope when no override", () => {
    const state: FlagStateResponse = {
      global: { "--debug": { enabled: true, value: "v" } },
      repo: {},
    };
    expect(
      rowStateFor(def, state, { kind: "repo", repoId: "r1" }),
    ).toEqual({
      enabled: true,
      value: "v",
      isOverride: false,
    });
  });

  it("returns disabled defaults when no value is persisted at all", () => {
    const state: FlagStateResponse = { global: {}, repo: {} };
    expect(rowStateFor(def, state, { kind: "global" })).toEqual({
      enabled: false,
      value: "",
      isOverride: false,
    });
  });

  it("treats null persisted value as empty string", () => {
    const state: FlagStateResponse = {
      global: { "--debug": { enabled: true, value: null } },
      repo: {},
    };
    expect(rowStateFor(def, state, { kind: "global" }).value).toBe("");
  });
});
