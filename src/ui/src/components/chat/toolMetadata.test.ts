import { describe, expect, it } from "vitest";
import { resolveToolSummary } from "./toolMetadata";

describe("resolveToolSummary", () => {
  describe("exact-match registry", () => {
    it("surfaces the SQL field for mcp__postgres__query", () => {
      // Pre-fix: extractToolSummary returned "" because the MCP
      // fallback only checked description/url/query/command.
      const result = resolveToolSummary(
        "mcp__postgres__query",
        JSON.stringify({ sql: "SELECT * FROM users WHERE id = 1" }),
      );
      expect(result.summary).toBe("SELECT * FROM users WHERE id = 1");
      expect(result.lang).toBe("sql");
      expect(result.fullContent).toBe("SELECT * FROM users WHERE id = 1");
    });

    it("highlights playwright browser_evaluate as javascript", () => {
      const result = resolveToolSummary(
        "mcp__plugin_playwright__browser_evaluate",
        JSON.stringify({ function: "() => document.title" }),
      );
      expect(result.summary).toBe("() => document.title");
      expect(result.lang).toBe("javascript");
    });

    it("renders Bash as bash regardless of input order", () => {
      const result = resolveToolSummary(
        "Bash",
        JSON.stringify({ description: "list files", command: "ls -la" }),
      );
      expect(result.summary).toBe("ls -la");
      expect(result.lang).toBe("bash");
    });
  });

  describe("tool-name heuristics", () => {
    it("infers SQL from a postgres-y MCP tool name with no registry entry", () => {
      // A new MCP server we've never seen — its name contains
      // "postgres", so we infer the `sql` field + sql highlighting.
      const result = resolveToolSummary(
        "mcp__pgcustom__exec_statement",
        JSON.stringify({ sql: "DELETE FROM logs" }),
      );
      expect(result.summary).toBe("DELETE FROM logs");
      expect(result.lang).toBe("sql");
    });

    it("infers SQL from a __query suffix on an unknown server", () => {
      const result = resolveToolSummary(
        "mcp__warehouse__query",
        JSON.stringify({ sql: "SELECT 1" }),
      );
      expect(result.summary).toBe("SELECT 1");
      expect(result.lang).toBe("sql");
    });

    it("infers JavaScript from an __evaluate suffix", () => {
      const result = resolveToolSummary(
        "mcp__customjs__evaluate",
        JSON.stringify({ code: "1 + 1" }),
      );
      expect(result.summary).toBe("1 + 1");
      expect(result.lang).toBe("javascript");
    });

    it("infers bash from a __shell-named MCP tool", () => {
      const result = resolveToolSummary(
        "mcp__remoteshell__exec",
        JSON.stringify({ command: "uptime" }),
      );
      expect(result.summary).toBe("uptime");
      expect(result.lang).toBe("bash");
    });
  });

  describe("field-name heuristics", () => {
    it("picks `sql` ahead of `description` when both are present", () => {
      const result = resolveToolSummary(
        "mcp__novel__exec",
        JSON.stringify({ description: "run a query", sql: "SELECT now()" }),
      );
      expect(result.summary).toBe("SELECT now()");
      expect(result.lang).toBe("sql");
    });

    it("falls through to longest string field when no known field matches", () => {
      const result = resolveToolSummary(
        "mcp__weird__op",
        JSON.stringify({
          format: "json",
          rationale: "this is the actual content the user cares about",
          flag: "yes",
        }),
      );
      expect(result.summary).toBe(
        "this is the actual content the user cares about",
      );
      expect(result.lang).toBeNull();
    });

    it("returns empty when no string-valued field is present (no good fallback)", () => {
      // All-numeric / boolean inputs intentionally produce an empty
      // summary rather than picking an arbitrary field — there's no
      // reliable signal for "which number is the user-facing one"
      // and rendering a stray `42` next to a tool name confuses more
      // than it clarifies. Built-in tools that genuinely surface a
      // numeric id (TaskGet, Monitor, etc.) handle their formatting in
      // `extractToolSummary`'s composite-summary switch.
      const result = resolveToolSummary(
        "mcp__weird__op",
        JSON.stringify({ count: 42, ok: true }),
      );
      expect(result.summary).toBe("");
    });
  });

  describe("edge cases", () => {
    it("returns an empty display for invalid JSON", () => {
      const result = resolveToolSummary("Bash", "{not valid json");
      expect(result).toEqual({ summary: "", lang: null, fullContent: "" });
    });

    it("returns an empty display for a non-object input", () => {
      const result = resolveToolSummary("Bash", JSON.stringify("just a string"));
      expect(result).toEqual({ summary: "", lang: null, fullContent: "" });
    });

    it("preserves long content in the row summary", () => {
      const longSql = "SELECT " + "x, ".repeat(100) + "y FROM t";
      const result = resolveToolSummary(
        "mcp__postgres__query",
        JSON.stringify({ sql: longSql }),
      );
      expect(result.summary).toBe(longSql);
      expect(result.fullContent).toBe(longSql);
    });

    it("renders TodoWrite as a count, not the array contents", () => {
      const result = resolveToolSummary(
        "TodoWrite",
        JSON.stringify({ todos: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
      );
      expect(result.summary).toBe("3 items");
    });

    it("preserves singular wording for a single-item TodoWrite", () => {
      const result = resolveToolSummary(
        "TodoWrite",
        JSON.stringify({ todos: [{ id: 1 }] }),
      );
      expect(result.summary).toBe("1 item");
    });
  });
});
