import { describe, expect, it } from "vitest";
import type {
  ClaudeFlagDef,
  FlagStateResponse,
} from "../../../services/claudeFlags";
import {
  filterFlags,
  partitionFlags,
  rowStateFor,
  sortFlags,
} from "./claudeFlagsLogic";

// The ClaudeFlagsSettings component is async data flow + JSX. The pieces
// of business logic worth pinning down — flag ordering, per-row state
// resolution, partition into Configured / Repo overrides / Inherited /
// Browse, and the search-and-filter helper — are extracted as pure
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

describe("partitionFlags (global scope)", () => {
  const apple = makeDef({ name: "--apple" });
  const mango = makeDef({ name: "--mango" });
  const zebra = makeDef({ name: "--zebra" });

  it("splits flags into configured (in state.global) vs browse", () => {
    const state: FlagStateResponse = {
      global: { "--mango": { enabled: true, value: null } },
      repo: {},
    };
    const out = partitionFlags(
      [zebra, apple, mango],
      state,
      { kind: "global" },
    );
    expect(out.configured.map((d) => d.name)).toEqual(["--mango"]);
    expect(out.browse.map((d) => d.name)).toEqual(["--apple", "--zebra"]);
    expect(out.repoOverrides).toEqual([]);
    expect(out.inherited).toEqual([]);
  });

  it("treats disabled global entries as configured", () => {
    const state: FlagStateResponse = {
      global: { "--mango": { enabled: false, value: null } },
      repo: {},
    };
    const out = partitionFlags([apple, mango], state, { kind: "global" });
    expect(out.configured.map((d) => d.name)).toEqual(["--mango"]);
  });
});

describe("partitionFlags (repo scope)", () => {
  const apple = makeDef({ name: "--apple" });
  const mango = makeDef({ name: "--mango" });
  const zebra = makeDef({ name: "--zebra" });

  it("repo entries land in repoOverrides; globals land in inherited", () => {
    const state: FlagStateResponse = {
      global: { "--apple": { enabled: true, value: null } },
      repo: { "--mango": { enabled: true, value: null } },
    };
    const out = partitionFlags(
      [zebra, apple, mango],
      state,
      { kind: "repo", repoId: "r1" },
    );
    expect(out.repoOverrides.map((d) => d.name)).toEqual(["--mango"]);
    expect(out.inherited.map((d) => d.name)).toEqual(["--apple"]);
    expect(out.browse.map((d) => d.name)).toEqual(["--zebra"]);
    expect(out.configured).toEqual([]);
  });

  it("a flag in both global + repo appears in both sections so the badge has a row", () => {
    // The inherited row stays visible even when the same flag has a repo
    // override — that's how the "overridden" badge gets a place to land.
    const state: FlagStateResponse = {
      global: { "--mango": { enabled: true, value: null } },
      repo: { "--mango": { enabled: false, value: "x" } },
    };
    const out = partitionFlags(
      [mango],
      state,
      { kind: "repo", repoId: "r1" },
    );
    expect(out.repoOverrides.map((d) => d.name)).toEqual(["--mango"]);
    expect(out.inherited.map((d) => d.name)).toEqual(["--mango"]);
    expect(out.browse).toEqual([]);
  });

  it("returns sorted results within each section", () => {
    const state: FlagStateResponse = { global: {}, repo: {} };
    const out = partitionFlags(
      [zebra, apple, mango],
      state,
      { kind: "repo", repoId: "r1" },
    );
    expect(out.browse.map((d) => d.name)).toEqual([
      "--apple",
      "--mango",
      "--zebra",
    ]);
  });
});

describe("filterFlags", () => {
  const debug = makeDef({
    name: "--debug",
    description: "Enable verbose logging",
  });
  const model = makeDef({
    name: "--model",
    takes_value: true,
    enum_choices: ["sonnet", "opus"],
    description: "Choose the Claude model",
  });
  const danger = makeDef({
    name: "--dangerously-skip-permissions",
    is_dangerous: true,
    description: "Skip permission prompts",
  });

  const all = [debug, model, danger];

  it("returns everything when query is empty and mode is 'all'", () => {
    expect(filterFlags(all, "", "all")).toEqual(all);
  });

  it("matches against the flag name", () => {
    expect(filterFlags(all, "model", "all")).toEqual([model]);
  });

  it("matches against the description case-insensitively", () => {
    expect(filterFlags(all, "VERBOSE", "all")).toEqual([debug]);
  });

  it("matches against enum choices", () => {
    expect(filterFlags(all, "sonnet", "all")).toEqual([model]);
  });

  it("filters to boolean-only flags", () => {
    expect(filterFlags(all, "", "boolean").map((d) => d.name)).toEqual([
      "--debug",
      "--dangerously-skip-permissions",
    ]);
  });

  it("filters to flags that take a value", () => {
    expect(filterFlags(all, "", "takes_value")).toEqual([model]);
  });

  it("filters to dangerous flags only", () => {
    expect(filterFlags(all, "", "dangerous")).toEqual([danger]);
  });

  it("combines mode filter with search query", () => {
    expect(filterFlags(all, "skip", "dangerous")).toEqual([danger]);
    expect(filterFlags(all, "model", "dangerous")).toEqual([]);
  });

  it("trims surrounding whitespace from the query", () => {
    expect(filterFlags(all, "  model  ", "all")).toEqual([model]);
  });
});
