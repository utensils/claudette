import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { bootIdentityGuard } from "./bootIdentityGuard";

// Minimal `document` stub. Vitest's default environment is node (no DOM),
// and we don't pull in jsdom or happy-dom — they'd add a CI dependency
// just for one tiny test. The guard only touches a handful of DOM APIs
// (querySelector, getElementById, createElement, .innerHTML), so we mock
// just those and assert against the recorded innerHTML strings.

interface FakeMeta {
  name: string;
  content: string;
}

interface FakeRoot {
  innerHTML: string;
}

let metas: FakeMeta[] = [];
let root: FakeRoot | null = null;
let bodyHtml = "";

const realGlobals = {
  document: (globalThis as { document?: unknown }).document,
  window: (globalThis as { window?: unknown }).window,
};

function installFakeDom() {
  metas = [];
  root = { innerHTML: "" };
  bodyHtml = "";
  (globalThis as { document?: unknown }).document = {
    querySelector(sel: string) {
      if (sel === 'meta[name="x-tauri-app-id"]') {
        return metas[0] ?? null;
      }
      return null;
    },
    getElementById(id: string) {
      if (id === "root") return root;
      return null;
    },
    get body() {
      return {
        get innerHTML() {
          return bodyHtml;
        },
        set innerHTML(v: string) {
          bodyHtml = v;
        },
      };
    },
  };
  (globalThis as { window?: unknown }).window = {};
}

function restoreDom() {
  if (realGlobals.document === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = realGlobals.document;
  }
  if (realGlobals.window === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = realGlobals.window;
  }
}

describe("bootIdentityGuard", () => {
  beforeEach(installFakeDom);
  afterAll(restoreDom);

  it("returns true when the meta tag matches the expected app id", () => {
    metas = [{ name: "x-tauri-app-id", content: "com.claudette.app" }];
    expect(bootIdentityGuard()).toBe(true);
    // Caller mounts React; root left untouched.
    expect(root?.innerHTML).toBe("");
  });

  it("returns false and renders an error overlay when the meta tag is missing", () => {
    metas = [];
    expect(bootIdentityGuard()).toBe(false);
    expect(root?.innerHTML).toContain("Foreign content detected");
    expect(root?.innerHTML).toContain("(missing)");
  });

  it("returns false when the meta tag has the wrong app id", () => {
    metas = [{ name: "x-tauri-app-id", content: "com.aethon.app" }];
    expect(bootIdentityGuard()).toBe(false);
    expect(root?.innerHTML).toContain("Foreign content detected");
    expect(root?.innerHTML).toContain("com.aethon.app");
  });

  it("escapes observed content in the error overlay (XSS via meta tag)", () => {
    metas = [
      { name: "x-tauri-app-id", content: '"><script>alert(1)</script>' },
    ];
    expect(bootIdentityGuard()).toBe(false);
    const html = root?.innerHTML ?? "";
    // Raw `<script>` must NOT appear unescaped.
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to body when no #root element exists", () => {
    metas = [{ name: "x-tauri-app-id", content: "com.aethon.app" }];
    root = null;
    expect(bootIdentityGuard()).toBe(false);
    expect(bodyHtml).toContain("Foreign content detected");
  });
});
