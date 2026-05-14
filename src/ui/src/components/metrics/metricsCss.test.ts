import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS_PATH = join(__dirname, "metrics.module.css");

function readCss(): string {
  return readFileSync(CSS_PATH, "utf8");
}

function ruleBody(css: string, selector: string): string {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*{([^}]*)}`,
  );
  const match = css.match(re);
  if (!match) throw new Error(`selector ${selector} not found in CSS`);
  return match[1];
}

describe("metrics.module.css invariants", () => {
  it("packs the stats strip with auto-fit so it steps down with the dashboard width", () => {
    const body = ruleBody(readCss(), ".statsStrip");
    expect(body).toMatch(
      /grid-template-columns:\s*repeat\(\s*auto-fit\s*,\s*minmax\(\s*160px\s*,\s*1fr\s*\)\s*\)/,
    );
  });

  it("packs the analytics grid with auto-fit so panels step 4 → 1 instead of 4 → 2 → 1", () => {
    const body = ruleBody(readCss(), ".analyticsGrid");
    expect(body).toMatch(
      /grid-template-columns:\s*repeat\(\s*auto-fit\s*,\s*minmax\(\s*220px\s*,\s*1fr\s*\)\s*\)/,
    );
  });

  it("makes each tile its own inline-size container so tile values can scale", () => {
    const body = ruleBody(readCss(), ".tile");
    expect(body).toMatch(/container-type:\s*inline-size/);
    expect(body).toMatch(/min-width:\s*0/);
  });

  it("scales tile values with the tile width via clamp() and cqi", () => {
    const body = ruleBody(readCss(), ".tileValue");
    expect(body).toMatch(/font-size:\s*clamp\([^)]*cqi[^)]*\)/);
    // The clamp is the headroom; ellipsis is the safety net for outlier values
    // (huge totals, long currency strings) at the auto-fit floor.
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("ellipsizes tile sub-text instead of wrapping into the chart area below", () => {
    const body = ruleBody(readCss(), ".tileSub");
    expect(body).toMatch(/white-space:\s*nowrap/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
    expect(body).toMatch(/min-width:\s*0/);
  });
});
