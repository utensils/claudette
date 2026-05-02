import { describe, it, expect } from "vitest";
import { flattenRegistry, type Registry } from "./community";

const REGISTRY: Registry = {
  version: 1,
  generated_at: "2026-05-02T06:00:00.000Z",
  source: {
    repo: "utensils/claudette-community",
    ref: "main",
    sha: "0".repeat(40),
  },
  themes: [
    {
      id: "catppuccin-mocha",
      name: "Catppuccin Mocha",
      description: "Pastel dark",
      color_scheme: "dark",
      accent_preview: "#cba6f7",
      version: "1.0.0",
      author: "alice",
      license: "MIT",
      tags: ["pastel"],
      submitted_at: "2026-04-12",
      source: {
        type: "in-tree",
        path: "themes/catppuccin-mocha",
        sha: "1".repeat(40),
        sha256: "a".repeat(64),
      },
    },
  ],
  plugins: {
    scm: [
      {
        name: "forgejo",
        display_name: "Forgejo",
        version: "1.0.0",
        description: "Forgejo PR/CI",
        kind: "scm",
        required_clis: ["forgejo"],
        author: "bob",
        license: "Apache-2.0",
        submitted_at: "2026-04-20",
        source: {
          type: "in-tree",
          path: "plugins/scm/forgejo",
          sha: "2".repeat(40),
          sha256: "b".repeat(64),
        },
      },
    ],
    "env-provider": [],
    "language-grammar": [
      {
        name: "lang-nix",
        display_name: "Nix",
        version: "1.0.0",
        description: "Nix syntax",
        kind: "language-grammar",
        author: "utensils",
        license: "MIT",
        submitted_at: "2026-05-01",
        source: {
          type: "in-tree",
          path: "plugins/language-grammars/lang-nix",
          sha: "3".repeat(40),
          sha256: "c".repeat(64),
        },
      },
    ],
  },
  slash_commands: [],
  mcp_recipes: [],
};

describe("flattenRegistry", () => {
  it("flattens themes + every plugin kind into a single typed list", () => {
    const out = flattenRegistry(REGISTRY);
    expect(out).toHaveLength(3);
    const kinds = out.map((e) => e.kind);
    expect(kinds).toContain("theme");
    expect(kinds).toContain("plugin:scm");
    expect(kinds).toContain("plugin:language-grammar");
  });

  it("preserves theme-specific fields", () => {
    const theme = flattenRegistry(REGISTRY).find((e) => e.kind === "theme");
    // Compare to the input fixture so the hex stays in one place
    // (the design-system token check exempts `accent_preview: "#..."`
    // — the fixture line — but not arbitrary equality assertions).
    expect(theme?.accent_preview).toBe(REGISTRY.themes[0].accent_preview);
    expect(theme?.color_scheme).toBe("dark");
  });

  it("preserves plugin required_clis", () => {
    const forgejo = flattenRegistry(REGISTRY).find(
      (e) => e.ident === "forgejo",
    );
    expect(forgejo?.required_clis).toEqual(["forgejo"]);
  });

  it("returns empty array for empty registry", () => {
    const empty: Registry = {
      ...REGISTRY,
      themes: [],
      plugins: { scm: [], "env-provider": [], "language-grammar": [] },
    };
    expect(flattenRegistry(empty)).toEqual([]);
  });
});
