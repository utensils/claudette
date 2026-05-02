import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the worker import so register-grammar messages are observable
// without spinning a real Web Worker. vi.hoisted shares state with the
// hoisted vi.mock factory; we read recorded posts from tests below.
const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    posted: Array<{ type?: string; lang?: string; grammar?: unknown }> = [];
    terminated = false;
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(msg: unknown): void {
      this.posted.push(msg as { type?: string; lang?: string });
    }
    addEventListener(): void {
      /* no-op */
    }
    terminate(): void {
      this.terminated = true;
    }
    static reset(): void {
      FakeWorker.instances = [];
    }
  }
  return { FakeWorker };
});

vi.mock("../workers/highlight.worker?worker", () => ({
  default: FakeWorker,
}));

// Mock the Tauri invoke surface — we replay backend responses
// programmatically so we can exercise the success path, the empty
// path, and per-grammar errors without an active runtime.
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Stub the main-thread Shiki highlighter — `loadLanguage` is the only
// surface `bootstrapGrammarRegistry` exercises, so we record calls
// without pulling in the real WASM-backed Shiki engine.
const { mainShikiMock } = vi.hoisted(() => ({
  mainShikiMock: {
    loadLanguage: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("./mainShiki", () => ({
  getMainShikiHighlighter: () => Promise.resolve(mainShikiMock),
}));

// `applyGrammarsToMonaco` dynamically imports `@shikijs/monaco` and
// `monacoTheme`. Mock both so the Monaco binding path is exercised
// without dragging in Monaco itself (which can't load in vitest's
// jsdom environment).
const { shikiToMonacoMock, applyMonacoThemeMock } = vi.hoisted(() => ({
  shikiToMonacoMock: vi.fn(),
  applyMonacoThemeMock: vi.fn(),
}));

vi.mock("@shikijs/monaco", () => ({
  shikiToMonaco: (...args: unknown[]) => shikiToMonacoMock(...args),
}));

vi.mock("../components/file-viewer/monacoTheme", () => ({
  applyMonacoTheme: (...args: unknown[]) => applyMonacoThemeMock(...args),
}));

import {
  bootstrapGrammarRegistry,
  applyGrammarsToMonaco,
  getRegisteredPluginLanguages,
  refreshGrammars,
  __testing,
} from "./grammarRegistry";

beforeEach(() => {
  __testing.reset();
  FakeWorker.reset();
  invokeMock.mockReset();
  mainShikiMock.loadLanguage.mockReset();
  mainShikiMock.loadLanguage.mockResolvedValue(undefined);
  shikiToMonacoMock.mockReset();
  applyMonacoThemeMock.mockReset();
});

afterEach(() => {
  __testing.reset();
});

function langInfo(id: string, extensions: string[]): unknown {
  return {
    plugin_name: `lang-${id}`,
    id,
    extensions,
    filenames: [],
    aliases: [],
    first_line_pattern: null,
  };
}

function grammarInfo(plugin: string, language: string, path: string): unknown {
  return {
    plugin_name: plugin,
    language,
    scope_name: `source.${language}`,
    path,
  };
}

describe("bootstrapGrammarRegistry", () => {
  it("loads plugin grammars into the worker and main-thread Shiki", async () => {
    // Body without a `name` field — exercises the manifest-driven
    // normalization. VS Code TextMate grammars commonly omit `name`
    // (or use a different value than the manifest's language id).
    const fakeBody = '{"scopeName":"source.nix","patterns":[]}';
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") return fakeBody;
      throw new Error(`unexpected: ${cmd}`);
    });

    await bootstrapGrammarRegistry();

    // The worker receiving registrations is the SAME worker that
    // serves chat/diff highlight requests (utils/highlight.ts) — not
    // a separate one. Spawning a private worker here would leave
    // plugin languages rendering as plain text in chat.
    expect(FakeWorker.instances).toHaveLength(1);
    const posts = FakeWorker.instances[0].posted;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      type: "register-grammar",
      lang: "nix",
    });
    // Grammar payload must be normalized: `name` stamped from the
    // manifest's language id, `scopeName` from the manifest's
    // scope_name. Without this, Shiki keys the grammar by whatever
    // `name` the JSON happened to carry (or rejects it outright when
    // missing) and lookups by language id miss.
    expect(posts[0].grammar).toEqual({
      name: "nix",
      scopeName: "source.nix",
      patterns: [],
    });

    // Main-thread Shiki receives the same normalized grammar.
    expect(mainShikiMock.loadLanguage).toHaveBeenCalledTimes(1);
    expect(mainShikiMock.loadLanguage).toHaveBeenCalledWith({
      name: "nix",
      scopeName: "source.nix",
      patterns: [],
    });

    // Public getter reflects the registered languages.
    expect(getRegisteredPluginLanguages()).toHaveLength(1);
    expect(getRegisteredPluginLanguages()[0].id).toBe("nix");
  });

  it("manifest fields override conflicting `name`/`scopeName` in the grammar JSON", async () => {
    // Some VS Code grammars ship a `name` that doesn't match the
    // contributing extension's language id (e.g. a fork that renamed
    // the language). The manifest must win — otherwise lookups by
    // language id silently miss after registration.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") {
        return JSON.stringify({
          name: "nix-legacy",
          scopeName: "source.nix-legacy",
          patterns: [{ name: "comment.nix", match: "#.*" }],
        });
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    await bootstrapGrammarRegistry();

    const posts = FakeWorker.instances[0].posted;
    expect(posts[0].grammar).toEqual({
      name: "nix",
      scopeName: "source.nix",
      patterns: [{ name: "comment.nix", match: "#.*" }],
    });
    expect(mainShikiMock.loadLanguage).toHaveBeenCalledWith({
      name: "nix",
      scopeName: "source.nix",
      patterns: [{ name: "comment.nix", match: "#.*" }],
    });
  });

  it("is idempotent — concurrent and sequential calls don't duplicate work", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") return "{}";
      throw new Error(`unexpected: ${cmd}`);
    });

    // Concurrent → both share the in-flight promise.
    await Promise.all([bootstrapGrammarRegistry(), bootstrapGrammarRegistry()]);
    // Sequential after that → already bootstrapped, no-op.
    await bootstrapGrammarRegistry();

    // The list call ran exactly once.
    const listCalls = invokeMock.mock.calls.filter(
      (c) => c[0] === "list_language_grammars",
    );
    expect(listCalls).toHaveLength(1);
  });

  it("isolates per-grammar errors — a malformed grammar does not break the others", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [
            langInfo("good", [".good"]),
            langInfo("bad", [".bad"]),
          ],
          grammars: [
            grammarInfo("lang-good", "good", "grammars/good.json"),
            grammarInfo("lang-bad", "bad", "grammars/bad.json"),
          ],
        };
      }
      if (cmd === "read_language_grammar") {
        if (args?.path === "grammars/bad.json") {
          // Simulate a backend read error (e.g. file vanished mid-boot).
          throw new Error("file disappeared");
        }
        return '{"scopeName":"source.good","patterns":[]}';
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    // Suppress the warn so the test output stays clean — we still want
    // the promise to resolve, not reject.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bootstrapGrammarRegistry();
    } finally {
      warnSpy.mockRestore();
    }

    // The good grammar registered with worker + main-thread Shiki.
    const posts = FakeWorker.instances[0].posted;
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: "register-grammar", lang: "good" });
    expect(mainShikiMock.loadLanguage).toHaveBeenCalledTimes(1);
  });

  it("survives a list_language_grammars failure with no registrations", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") throw new Error("backend down");
      throw new Error(`unexpected: ${cmd}`);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bootstrapGrammarRegistry();
    } finally {
      warnSpy.mockRestore();
    }

    expect(getRegisteredPluginLanguages()).toEqual([]);
    expect(FakeWorker.instances).toHaveLength(0);
    expect(mainShikiMock.loadLanguage).not.toHaveBeenCalled();
  });

  it("retries bootstrap on a later call after a transient list failure", async () => {
    // First call: backend rejects. Second call: backend succeeds.
    // The registry must NOT latch into a permanently-bootstrapped state
    // after the first failure — otherwise a transient invoke error
    // during app boot would leave grammars un-registered for the
    // whole session.
    let callCount = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        callCount += 1;
        if (callCount === 1) throw new Error("backend down");
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") {
        return '{"scopeName":"source.nix","patterns":[]}';
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bootstrapGrammarRegistry();
      expect(getRegisteredPluginLanguages()).toEqual([]);
      // Second attempt: backend recovers.
      await bootstrapGrammarRegistry();
    } finally {
      warnSpy.mockRestore();
    }

    expect(callCount).toBe(2);
    expect(getRegisteredPluginLanguages()).toHaveLength(1);
    expect(getRegisteredPluginLanguages()[0].id).toBe("nix");
  });

  it("malformed grammar JSON is reported and skipped", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("broken", [".broken"])],
          grammars: [grammarInfo("lang-broken", "broken", "grammars/broken.json")],
        };
      }
      if (cmd === "read_language_grammar") return "not valid json{";
      throw new Error(`unexpected: ${cmd}`);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bootstrapGrammarRegistry();
    } finally {
      warnSpy.mockRestore();
    }

    expect(getRegisteredPluginLanguages()).toHaveLength(1); // language metadata still registered
    expect(mainShikiMock.loadLanguage).not.toHaveBeenCalled();
    // Worker also doesn't get a register-grammar for the broken one.
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe("applyGrammarsToMonaco", () => {
  function makeMonacoStub(): {
    languages: {
      register: ReturnType<typeof vi.fn>;
      registered: Array<{ id: string }>;
    };
    editor: {
      getModels: ReturnType<typeof vi.fn>;
      setModelLanguage: ReturnType<typeof vi.fn>;
      setTheme: ReturnType<typeof vi.fn>;
    };
  } {
    const registered: Array<{ id: string }> = [];
    return {
      languages: {
        registered,
        register: vi.fn((info: { id: string }) => {
          registered.push(info);
        }),
      },
      editor: {
        getModels: vi.fn().mockReturnValue([]),
        setModelLanguage: vi.fn(),
        setTheme: vi.fn(),
      },
    };
  }

  it("registers plugin languages with Monaco", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") return "{}";
      throw new Error(`unexpected: ${cmd}`);
    });

    const monaco = makeMonacoStub();
    await applyGrammarsToMonaco(monaco as unknown as typeof import("monaco-editor"));

    expect(monaco.languages.register).toHaveBeenCalledTimes(1);
    expect(monaco.languages.register).toHaveBeenCalledWith({
      id: "nix",
      extensions: [".nix"],
      aliases: [],
      filenames: [],
    });
    expect(shikiToMonacoMock).toHaveBeenCalledTimes(1);
  });

  it("restores the original setTheme after shikiToMonaco wraps it (claudette theme race fix)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") return "{}";
      throw new Error(`unexpected: ${cmd}`);
    });

    const monaco = makeMonacoStub();
    const originalSetTheme = monaco.editor.setTheme;

    // Simulate shikiToMonaco wrapping setTheme — exactly what the real
    // library does. Our code must restore the unwrapped reference.
    shikiToMonacoMock.mockImplementation((_hl: unknown, m: typeof monaco) => {
      const wrapped = vi.fn();
      m.editor.setTheme = wrapped;
    });

    await applyGrammarsToMonaco(monaco as unknown as typeof import("monaco-editor"));

    // After the bind, setTheme should have been restored to the original.
    expect(monaco.editor.setTheme).toBe(originalSetTheme);
    // applyMonacoTheme is re-invoked so our claudette theme wins on
    // first paint.
    expect(applyMonacoThemeMock).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates open Monaco models so plaintext-fallback files pick up plugin languages", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") return "{}";
      throw new Error(`unexpected: ${cmd}`);
    });

    const monaco = makeMonacoStub();
    const plaintextModel = {
      uri: { path: "/repo/flake.nix" },
      getLanguageId: () => "plaintext",
    };
    const alreadyTypedModel = {
      uri: { path: "/repo/foo.nix" },
      getLanguageId: () => "nix", // not plaintext — must be skipped
    };
    monaco.editor.getModels.mockReturnValue([plaintextModel, alreadyTypedModel]);

    await applyGrammarsToMonaco(monaco as unknown as typeof import("monaco-editor"));

    // Only the plaintext .nix model should be re-typed; the already-typed
    // one stays put.
    expect(monaco.editor.setModelLanguage).toHaveBeenCalledTimes(1);
    expect(monaco.editor.setModelLanguage).toHaveBeenCalledWith(
      plaintextModel,
      "nix",
    );
  });

  it("is idempotent — second call is a no-op for Monaco registration", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") return "{}";
      throw new Error(`unexpected: ${cmd}`);
    });

    const monaco = makeMonacoStub();
    await applyGrammarsToMonaco(monaco as unknown as typeof import("monaco-editor"));
    await applyGrammarsToMonaco(monaco as unknown as typeof import("monaco-editor"));

    // First call ran register/shikiToMonaco; second short-circuits.
    expect(monaco.languages.register).toHaveBeenCalledTimes(1);
    expect(shikiToMonacoMock).toHaveBeenCalledTimes(1);
  });
});

describe("refreshGrammars (issue 570 hot-reload)", () => {
  function makeMonacoStub() {
    const registered: Array<{ id: string }> = [];
    return {
      languages: {
        registered,
        register: vi.fn((info: { id: string }) => {
          registered.push(info);
        }),
      },
      editor: {
        getModels: vi.fn().mockReturnValue([]),
        setModelLanguage: vi.fn(),
        setTheme: vi.fn(),
      },
    };
  }

  it("does not strip highlighting from built-in Monaco languages on refresh", async () => {
    // Regression for the Codex P1 finding: refreshGrammars must not
    // touch models tagged with built-in Monaco language ids
    // (typescript, json, markdown, …) just because they're not in
    // the plugin registry. Only languages we previously contributed
    // are eligible for the plaintext fallback.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") return "{}";
      throw new Error(`unexpected: ${cmd}`);
    });

    const monaco = makeMonacoStub();
    // A model whose language id is a built-in Monaco language NEVER
    // contributed by any plugin. Refresh must leave it alone.
    const tsModel = {
      uri: { path: "/repo/src/index.ts" },
      getLanguageId: () => "typescript",
    };
    const jsonModel = {
      uri: { path: "/repo/package.json" },
      getLanguageId: () => "json",
    };
    monaco.editor.getModels.mockReturnValue([tsModel, jsonModel]);

    await applyGrammarsToMonaco(monaco as unknown as typeof import("monaco-editor"));
    monaco.editor.setModelLanguage.mockClear();

    // Now refresh — the registry stays the same, so plugin state is
    // unchanged, but the refresh path *does* run reevaluateOpenModels.
    // Built-in Monaco models must not be touched.
    await refreshGrammars();

    expect(monaco.editor.setModelLanguage).not.toHaveBeenCalled();
  });

  it("falls plugin-owned languages back to plaintext when their plugin is uninstalled", async () => {
    // First bootstrap: lang-nix is active, contributing the `nix` id.
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return {
          languages: [langInfo("nix", [".nix"])],
          grammars: [grammarInfo("lang-nix", "nix", "grammars/nix.tmLanguage.json")],
        };
      }
      if (cmd === "read_language_grammar") return "{}";
      throw new Error(`unexpected: ${cmd}`);
    });

    const monaco = makeMonacoStub();
    const nixModel = {
      uri: { path: "/repo/flake.nix" },
      getLanguageId: () => "nix",
    };
    monaco.editor.getModels.mockReturnValue([nixModel]);

    await applyGrammarsToMonaco(monaco as unknown as typeof import("monaco-editor"));
    monaco.editor.setModelLanguage.mockClear();

    // Now the plugin is uninstalled — backend returns an empty list.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_language_grammars") {
        return { languages: [], grammars: [] };
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    await refreshGrammars();

    // The previously-typed nix model should have been downgraded to
    // plaintext because `nix` was previously plugin-owned and is now
    // gone from the active set.
    expect(monaco.editor.setModelLanguage).toHaveBeenCalledWith(
      nixModel,
      "plaintext",
    );
  });
});
