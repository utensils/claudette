import { describe, expect, it } from "vitest";
import type { ClaudeFlagDef } from "../../../services/claudeFlags";
import { flagInputKind, rowIsReadOnly } from "./claudeFlagRowLogic";

// The ClaudeFlagRow component is thin JSX over two pure decisions:
// (1) which value-input shape to render based on the flag definition, and
// (2) whether the row's controls should be locked (repo scope, no override
// yet). Both are unit-tested here without a DOM harness — same convention as
// other pure-helper tests in this tree.

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

describe("flagInputKind", () => {
  it("returns 'none' for boolean flags", () => {
    expect(flagInputKind(makeDef({ takes_value: false }))).toBe("none");
  });

  it("returns 'select' when the flag has enum choices", () => {
    expect(
      flagInputKind(
        makeDef({
          takes_value: true,
          enum_choices: ["plan", "acceptEdits"],
        }),
      ),
    ).toBe("select");
  });

  it("returns 'text' when the flag takes a value with no enum", () => {
    expect(
      flagInputKind(
        makeDef({ takes_value: true, value_placeholder: "directories" }),
      ),
    ).toBe("text");
  });

  it("treats an empty enum_choices array as text input", () => {
    expect(
      flagInputKind(makeDef({ takes_value: true, enum_choices: [] })),
    ).toBe("text");
  });
});

describe("rowIsReadOnly", () => {
  it("is never read-only at global scope", () => {
    expect(rowIsReadOnly("global", undefined)).toBe(false);
    expect(rowIsReadOnly("global", true)).toBe(false);
    expect(rowIsReadOnly("global", false)).toBe(false);
  });

  it("is read-only at repo scope when no override is active", () => {
    expect(rowIsReadOnly("repo", false)).toBe(true);
    expect(rowIsReadOnly("repo", undefined)).toBe(true);
  });

  it("is writable at repo scope when override is on", () => {
    expect(rowIsReadOnly("repo", true)).toBe(false);
  });
});
