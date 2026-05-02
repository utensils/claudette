import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to keep a mutable reference visible inside the mock
// factory below. The factory itself runs hoisted (above all imports),
// so we can't close over module-scoped state declared lower down.
const { langsRef } = vi.hoisted(() => ({
  langsRef: { current: [] as LangSnapshot[] },
}));

vi.mock("./grammarRegistry", () => ({
  getRegisteredPluginLanguages: () => langsRef.current,
}));

interface LangSnapshot {
  plugin_name: string;
  id: string;
  extensions: string[];
  filenames: string[];
  aliases: string[];
  first_line_pattern: string | null;
}

function makeLang(
  id: string,
  extensions: string[],
  filenames: string[] = [],
): LangSnapshot {
  return {
    plugin_name: `lang-${id}`,
    id,
    extensions,
    filenames,
    aliases: [],
    first_line_pattern: null,
  };
}

import { languageForFile } from "./languageForFile";

beforeEach(() => {
  // Reset plugin contributions before each test; opt-in per case.
  langsRef.current = [];
});

describe("languageForFile — built-in extensions", () => {
  it("resolves common extensions to their Shiki language id", () => {
    expect(languageForFile("foo.rs")).toBe("rust");
    expect(languageForFile("foo.ts")).toBe("typescript");
    expect(languageForFile("foo.tsx")).toBe("tsx");
    expect(languageForFile("foo.py")).toBe("python");
    expect(languageForFile("foo.go")).toBe("go");
  });

  it("strips paths and is case-insensitive", () => {
    expect(languageForFile("a/b/c/SCRIPT.JS")).toBe("javascript");
    expect(languageForFile("/abs/Path/Foo.NIX")).toBe("nix");
  });

  it("matches .nix to nix as a built-in (so the bundled plugin doesn't double-resolve)", () => {
    expect(languageForFile("flake.nix")).toBe("nix");
  });

  it("returns null for unknown extensions and extensionless files", () => {
    expect(languageForFile("foo.unknownext")).toBeNull();
    expect(languageForFile("README")).toBeNull();
    expect(languageForFile("")).toBeNull();
    expect(languageForFile(null)).toBeNull();
    expect(languageForFile(undefined)).toBeNull();
  });
});

describe("languageForFile — built-in filename mappings", () => {
  it("matches well-known no-extension filenames", () => {
    expect(languageForFile("Dockerfile")).toBe("dockerfile");
    expect(languageForFile("Makefile")).toBe("make");
  });

  it("matches case-insensitively", () => {
    expect(languageForFile("dockerfile")).toBe("dockerfile");
    expect(languageForFile("DOCKERFILE")).toBe("dockerfile");
  });
});

describe("languageForFile — plugin contributions", () => {
  it("resolves a plugin-contributed extension", () => {
    langsRef.current = [makeLang("zig-lang", [".zig2"])];
    expect(languageForFile("foo.zig2")).toBe("zig-lang");
  });

  it("resolves a plugin-contributed filename", () => {
    langsRef.current = [makeLang("buildkit", [], ["Buildfile"])];
    expect(languageForFile("Buildfile")).toBe("buildkit");
  });

  it("plugin filenames take priority over built-in filename mappings", () => {
    langsRef.current = [makeLang("dockerfile-modern", [], ["Dockerfile"])];
    expect(languageForFile("Dockerfile")).toBe("dockerfile-modern");
  });

  it("plugin extensions take priority over built-in extension mappings", () => {
    // A plugin shipping `.ts` would shadow the built-in typescript mapping.
    langsRef.current = [makeLang("ts-experiment", [".ts"])];
    expect(languageForFile("foo.ts")).toBe("ts-experiment");
  });

  it("falls back to built-ins when no plugin matches", () => {
    langsRef.current = [makeLang("isolated", [".isolated"])];
    expect(languageForFile("foo.rs")).toBe("rust");
  });

  it("returns null when no plugin and no built-in matches", () => {
    langsRef.current = [makeLang("zig-lang", [".zig2"])];
    expect(languageForFile("foo.bogus")).toBeNull();
  });

  it("compares plugin extensions case-insensitively", () => {
    langsRef.current = [makeLang("foo", [".FOO"])];
    expect(languageForFile("readme.foo")).toBe("foo");
  });
});
