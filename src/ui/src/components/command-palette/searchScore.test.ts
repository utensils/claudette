import { describe, it, expect } from "vitest";
import { scoreCommand } from "./searchScore";

describe("scoreCommand", () => {
  it("returns 100 for exact name match", () => {
    expect(scoreCommand("Stop Agent", undefined, undefined, "stop agent")).toBe(100);
  });

  it("returns 80 when name starts with query", () => {
    expect(scoreCommand("Stop Agent", undefined, undefined, "stop")).toBe(80);
  });

  it("returns 60 for word-boundary match", () => {
    // "Theme" starts with "the"
    expect(scoreCommand("Change Theme", undefined, undefined, "the")).toBe(60);
  });

  it("returns 40 when name contains query mid-word", () => {
    // "sThe" doesn't start a word, but "the" is inside the name
    expect(scoreCommand("Gather", undefined, undefined, "the")).toBe(40);
  });

  it("returns 20 when only description matches", () => {
    expect(
      scoreCommand("Stop Agent", "Kill the running agent process", undefined, "kill"),
    ).toBe(20);
  });

  it("returns 10 when only keyword matches", () => {
    expect(scoreCommand("Stop Agent", undefined, ["halt", "cancel"], "cancel")).toBe(10);
  });

  it("returns 0 when nothing matches", () => {
    expect(scoreCommand("Stop Agent", "Kill the process", undefined, "xyz")).toBe(0);
  });

  it("ranks Theme above Stop Agent for query 'the'", () => {
    const themeScore = scoreCommand("Change Theme", "12 themes available", undefined, "the");
    const stopScore = scoreCommand(
      "Stop Agent",
      "Kill the running agent process",
      undefined,
      "the",
    );
    expect(themeScore).toBeGreaterThan(stopScore);
  });

  it("is case insensitive", () => {
    expect(scoreCommand("Change Theme", undefined, undefined, "THE")).toBe(60);
    expect(scoreCommand("CHANGE THEME", undefined, undefined, "the")).toBe(60);
  });
});
