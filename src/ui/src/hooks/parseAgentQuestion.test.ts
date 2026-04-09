import { describe, it, expect } from "vitest";
import { parseAskUserQuestion, parseOptions } from "./parseAgentQuestion";

describe("parseOptions", () => {
  it("returns empty array for non-array input", () => {
    expect(parseOptions(undefined)).toEqual([]);
    expect(parseOptions(null)).toEqual([]);
    expect(parseOptions("not an array")).toEqual([]);
  });

  it("wraps string options into { label } objects", () => {
    expect(parseOptions(["A", "B"])).toEqual([
      { label: "A" },
      { label: "B" },
    ]);
  });

  it("preserves label and description from object options", () => {
    const opts = [
      { label: "Nix", description: "Declarative builds" },
      { label: "Docker" },
    ];
    expect(parseOptions(opts)).toEqual([
      { label: "Nix", description: "Declarative builds" },
      { label: "Docker", description: undefined },
    ]);
  });

  it("stringifies non-string, non-object values", () => {
    expect(parseOptions([42, true])).toEqual([
      { label: "42" },
      { label: "true" },
    ]);
  });
});

describe("parseAskUserQuestion", () => {
  it("parses single-question format", () => {
    const input = {
      question: "Pick a color",
      options: ["Red", "Blue"],
    };
    const result = parseAskUserQuestion(input);
    expect(result).toEqual([
      {
        question: "Pick a color",
        options: [{ label: "Red" }, { label: "Blue" }],
        multiSelect: false,
      },
    ]);
  });

  it("parses multi-question format", () => {
    const input = {
      questions: [
        {
          header: "Deployment",
          question: "How do you deploy?",
          options: [{ label: "Nix", description: "Reproducible" }],
          multiSelect: false,
        },
        {
          question: "Testing?",
          options: ["Unit", "Integration"],
          multiSelect: true,
        },
      ],
    };
    const result = parseAskUserQuestion(input);
    expect(result).toHaveLength(2);
    expect(result[0].header).toBe("Deployment");
    expect(result[0].question).toBe("How do you deploy?");
    expect(result[0].options).toEqual([
      { label: "Nix", description: "Reproducible" },
    ]);
    expect(result[1].multiSelect).toBe(true);
    expect(result[1].header).toBeUndefined();
  });

  it("returns empty array for unrecognized format", () => {
    expect(parseAskUserQuestion({})).toEqual([]);
    expect(parseAskUserQuestion({ random: "data" })).toEqual([]);
  });

  it("handles missing options gracefully", () => {
    const result = parseAskUserQuestion({ question: "No options here" });
    expect(result).toEqual([
      { question: "No options here", options: [], multiSelect: false },
    ]);
  });
});
