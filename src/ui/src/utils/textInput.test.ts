import { describe, expect, it } from "vitest";
import { normalizeShellScriptInput, PLAIN_TEXT_INPUT_PROPS } from "./textInput";

describe("textInput helpers", () => {
  it("normalizes smart quotes in shell script text", () => {
    expect(
      normalizeShellScriptInput(
        "export PATH=\u201ctest\u201d; echo \u2018ok\u2019",
      ),
    ).toBe("export PATH=\"test\"; echo 'ok'");
  });

  it("disables browser typing substitutions for exact-text fields", () => {
    expect(PLAIN_TEXT_INPUT_PROPS).toEqual({
      // `autoComplete: "off"` suppresses browser-remembered values for
      // inputs that hold raw content (env var names, scripts, ids) where
      // autofill is a regression rather than a convenience.
      autoComplete: "off",
      autoCapitalize: "off",
      autoCorrect: "off",
      spellCheck: false,
    });
  });
});
