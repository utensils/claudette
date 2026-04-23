import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Heatmap } from "./Heatmap";

describe("Heatmap", () => {
  it("renders an svg with an explicit aspect-ratio matching its viewBox", () => {
    const html = renderToString(<Heatmap cells={[]} />);
    const width = 13 * (11 + 2) - 2;
    const height = 7 * (11 + 2) - 2;
    expect(html).toContain(`viewBox="0 0 ${width} ${height}"`);
    expect(html).toMatch(/aspect-ratio:\s*167\s*\/\s*89/);
  });

  it("propagates aspect-ratio when custom dimensions are supplied", () => {
    const html = renderToString(
      <Heatmap cells={[]} weeks={4} days={7} cellSize={10} gap={1} />
    );
    const width = 4 * (10 + 1) - 1;
    const height = 7 * (10 + 1) - 1;
    expect(html).toContain(`viewBox="0 0 ${width} ${height}"`);
    expect(html).toMatch(
      new RegExp(`aspect-ratio:\\s*${width}\\s*/\\s*${height}`)
    );
  });
});
