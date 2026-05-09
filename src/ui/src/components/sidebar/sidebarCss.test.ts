import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS_DIR = join(__dirname);

function readCss(file: string): string {
  return readFileSync(join(CSS_DIR, file), "utf8");
}

function ruleBody(css: string, selector: string): string {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*{([^}]*)}`,
  );
  const match = css.match(re);
  if (!match) throw new Error(`selector ${selector} not found in CSS`);
  return match[1];
}

describe("Sidebar.module.css invariants", () => {
  it("keeps project hover actions inside narrow sidebar rows", () => {
    const css = readCss("Sidebar.module.css");
    const repoName = ruleBody(css, ".repoName");
    const repoTitle = ruleBody(css, ".repoTitle");
    const iconBtn = ruleBody(css, ".iconBtn");

    expect(repoName).toMatch(/min-width:\s*0\s*;/);
    expect(repoTitle).toMatch(/overflow:\s*hidden\s*;/);
    expect(repoTitle).toMatch(/text-overflow:\s*ellipsis\s*;/);
    expect(repoTitle).toMatch(/white-space:\s*nowrap\s*;/);
    expect(iconBtn).toMatch(/flex-shrink:\s*0\s*;/);
  });

  it("reveals project action buttons on hover and keyboard focus", () => {
    const css = readCss("Sidebar.module.css");

    expect(css).toMatch(/\.repoHeader:hover\s+\.iconBtn,/);
    expect(css).toMatch(/\.repoHeader:focus-within\s+\.iconBtn,/);
    expect(css).toMatch(/\.wsItem:hover\s+\.iconBtn\s*{\s*opacity:\s*1\s*;/);
  });
});
