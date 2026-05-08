import { describe, expect, it } from "vitest";
import {
  parseInvocation,
  shouldShowBanner,
  summarizeInvocation,
  tokenizeShellLine,
  truncateMiddle,
} from "./cliInvocationBannerLogic";

describe("shouldShowBanner", () => {
  it("returns false when invocation is null", () => {
    expect(shouldShowBanner(null)).toBe(false);
  });

  it("returns false when invocation is an empty string", () => {
    expect(shouldShowBanner("")).toBe(false);
  });

  it("returns false when invocation is whitespace only", () => {
    expect(shouldShowBanner("   ")).toBe(false);
  });

  it("returns true on a real invocation string", () => {
    expect(
      shouldShowBanner("/bin/claude --print --session-id abc <prompt>"),
    ).toBe(true);
  });
});

describe("tokenizeShellLine", () => {
  it("splits on whitespace", () => {
    expect(tokenizeShellLine("a b  c\td")).toEqual(["a", "b", "c", "d"]);
  });

  it("preserves single-quoted strings verbatim", () => {
    expect(tokenizeShellLine("a 'b c' d")).toEqual(["a", "b c", "d"]);
  });

  it("preserves double-quoted strings", () => {
    expect(tokenizeShellLine('a "b c" d')).toEqual(["a", "b c", "d"]);
  });

  it("decodes backslash-escaped chars inside double quotes", () => {
    expect(tokenizeShellLine('"a\\"b" c')).toEqual(['a"b', "c"]);
  });

  it("handles empty quoted token", () => {
    expect(tokenizeShellLine('a "" b')).toEqual(["a", "", "b"]);
  });

  it("decodes the backend's `'\\''` idiom to a literal single quote", () => {
    // src/agent/args.rs::shell_quote closes the single-quote span, emits
    // an escaped quote (`\'`), and reopens. The whole thing must round-trip
    // back to a single token containing a literal `'`.
    expect(tokenizeShellLine("'O'\\''Reilly'")).toEqual(["O'Reilly"]);
  });

  it("treats a bare `\\x` outside quotes as the literal `x`", () => {
    expect(tokenizeShellLine("\\'")).toEqual(["'"]);
    expect(tokenizeShellLine("a\\ b")).toEqual(["a b"]);
  });

  it("returns empty array for empty input", () => {
    expect(tokenizeShellLine("")).toEqual([]);
  });
});

describe("parseInvocation", () => {
  it("returns null for empty input", () => {
    expect(parseInvocation("")).toBeNull();
  });

  it("derives binary name from the last path segment", () => {
    const parsed = parseInvocation("/Users/jb/.local/bin/claude --print");
    expect(parsed?.binary).toBe("claude");
    expect(parsed?.binaryFullPath).toBe("/Users/jb/.local/bin/claude");
  });

  it("groups --flag value pairs", () => {
    const parsed = parseInvocation(
      "/bin/claude --model opus --session-id abc-123 <prompt>",
    );
    expect(parsed?.flags).toEqual([
      { name: "--model", value: "opus" },
      { name: "--session-id", value: "abc-123" },
    ]);
    expect(parsed?.prompt).toBe("<prompt>");
  });

  it("identifies boolean flags (no value before next flag)", () => {
    const parsed = parseInvocation(
      "/bin/claude --print --verbose --model opus",
    );
    expect(parsed?.flags).toEqual([
      { name: "--print", value: null },
      { name: "--verbose", value: null },
      { name: "--model", value: "opus" },
    ]);
    expect(parsed?.prompt).toBeNull();
  });

  it("splits inline --flag=value form", () => {
    const parsed = parseInvocation("/bin/claude --output-format=stream-json");
    expect(parsed?.flags).toEqual([
      { name: "--output-format", value: "stream-json" },
    ]);
  });

  it("preserves the original raw string for copy", () => {
    const raw = "/bin/claude --model opus <prompt>";
    expect(parseInvocation(raw)?.raw).toBe(raw);
  });

  it("captures redacted values as the flag value", () => {
    const parsed = parseInvocation(
      "/bin/claude --mcp-config <redacted> --print",
    );
    expect(parsed?.flags).toEqual([
      { name: "--mcp-config", value: "<redacted>" },
      { name: "--print", value: null },
    ]);
  });

  it("matches the real invocation shape from the screenshot", () => {
    const parsed = parseInvocation(
      "/Users/jamesbrink/.local/bin/claude --print --output-format stream-json --input-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --session-id 9cde1d6d-6c9b-48df-9765-5c8bcf522919 --model opus <prompt>",
    );
    expect(parsed?.binary).toBe("claude");
    expect(parsed?.flags.map((f) => f.name)).toEqual([
      "--print",
      "--output-format",
      "--input-format",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "--session-id",
      "--model",
    ]);
    expect(parsed?.prompt).toBe("<prompt>");
  });
});

describe("truncateMiddle", () => {
  it("passes short values through", () => {
    expect(truncateMiddle("opus")).toBe("opus");
  });

  it("inserts ellipsis with default head/tail", () => {
    expect(truncateMiddle("9cde1d6d-6c9b-48df-9765-5c8bcf522919")).toBe(
      "9cde…2919",
    );
  });
});

describe("summarizeInvocation", () => {
  // These cases pin the contract for the user-implemented summary line.
  // Whatever shape the contributor picks, the result must:
  //   - start with the binary's display name
  //   - never include the redacted positional `<prompt>`
  //   - never include sensitive `<redacted>` values verbatim
  //   - stay reasonably short (< 80 chars on a typical invocation)
  it("starts with the binary display name", () => {
    const parsed = parseInvocation(
      "/Users/jb/.local/bin/claude --print --model opus",
    )!;
    const summary = summarizeInvocation(parsed);
    expect(summary.startsWith("claude")).toBe(true);
  });

  it("never leaks the <prompt> placeholder", () => {
    const parsed = parseInvocation(
      "/bin/claude --model opus <prompt>",
    )!;
    expect(summarizeInvocation(parsed)).not.toContain("<prompt>");
  });

  it("never leaks raw <redacted> bodies", () => {
    const parsed = parseInvocation(
      "/bin/claude --mcp-config <redacted> --model opus",
    )!;
    expect(summarizeInvocation(parsed)).not.toContain("<redacted>");
  });

  it("stays short on a realistic invocation", () => {
    const parsed = parseInvocation(
      "/Users/jamesbrink/.local/bin/claude --print --output-format stream-json --input-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --session-id 9cde1d6d-6c9b-48df-9765-5c8bcf522919 --model opus <prompt>",
    )!;
    expect(summarizeInvocation(parsed).length).toBeLessThan(80);
  });
});
