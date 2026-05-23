import { describe, expect, it } from "vitest";
import { isMcpToolName, parseMcpToolName } from "./mcpToolName";

describe("parseMcpToolName", () => {
  it("splits the simple mcp__<server>__<tool> shape", () => {
    expect(parseMcpToolName("mcp__datadog__search_datadog_dashboards")).toEqual({
      server: "datadog",
      tool: "search_datadog_dashboards",
    });
  });

  it("treats only the first __ after the prefix as the server boundary", () => {
    // Server names can contain single underscores; the tool keeps any
    // remaining underscores intact.
    expect(parseMcpToolName("mcp__claude_ai_Gmail__authenticate")).toEqual({
      server: "claude_ai_Gmail",
      tool: "authenticate",
    });
    expect(parseMcpToolName("mcp__datadog__load_datadog_skill")).toEqual({
      server: "datadog",
      tool: "load_datadog_skill",
    });
  });

  it("returns null for non-MCP tool names", () => {
    expect(parseMcpToolName("Read")).toBeNull();
    expect(parseMcpToolName("Bash")).toBeNull();
    // Missing the tool segment — not a usable MCP tool name.
    expect(parseMcpToolName("mcp__server")).toBeNull();
    expect(parseMcpToolName("mcp__server__")).toBeNull();
  });

  it("isMcpToolName mirrors parse success", () => {
    expect(isMcpToolName("mcp__datadog__search")).toBe(true);
    expect(isMcpToolName("Edit")).toBe(false);
  });
});
