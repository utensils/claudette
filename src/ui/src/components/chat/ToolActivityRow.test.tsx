// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolActivity } from "../../stores/useAppStore";
import { useAppStore } from "../../stores/useAppStore";
import { ToolActivityRow } from "./ToolActivityRow";

const { highlightCalls, highlightCache } = vi.hoisted(() => ({
  highlightCalls: [] as Array<{ code: string; lang: string }>,
  highlightCache: new Map<string, string>(),
}));

vi.mock("../../utils/highlight", () => ({
  getCachedHighlight: (code: string, lang: string) =>
    highlightCache.get(`${lang}\0${code}`) ?? null,
  highlightCode: async (code: string, lang: string) => {
    highlightCalls.push({ code, lang });
    const html = `<span data-highlight-lang="${lang}">${code}</span>`;
    highlightCache.set(`${lang}\0${code}`, html);
    return html;
  },
}));

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function activity(
  toolName: string,
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId: `${toolName}-1`,
    toolName,
    inputJson: "{}",
    resultText: "done",
    collapsed: true,
    summary: "",
    ...overrides,
  };
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

beforeEach(() => {
  highlightCalls.length = 0;
  highlightCache.clear();
  useAppStore.setState({
    expandedToolUseIds: {},
    extendedToolCallOutput: true,
  });
});

afterEach(async () => {
  useAppStore.setState({
    expandedToolUseIds: {},
    extendedToolCallOutput: false,
  });
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
});

describe("ToolActivityRow", () => {
  it("uses the compact row without a detail chevron when extended output is disabled", async () => {
    useAppStore.setState({ extendedToolCallOutput: false });
    const container = await render(
      <ToolActivityRow
        activity={activity("Bash", {
          inputJson: JSON.stringify({ command: "echo one" }),
        })}
        searchQuery=""
      />,
    );

    expect(container.textContent).toContain("Bash");
    expect(container.textContent).toContain("echo one");
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(highlightCalls).toEqual([]);
  });

  it("toggles highlighted full input details for code-like tools", async () => {
    const sql = "WITH users AS (\n  SELECT * FROM users\n)\nSELECT * FROM users";
    const container = await render(
      <ToolActivityRow
        activity={activity("mcp__postgres__query", {
          inputJson: JSON.stringify({ sql }),
        })}
        searchQuery=""
      />,
    );

    const toggle = container.querySelector(
      'button[aria-label="Expand mcp__postgres__query input details"]',
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("pre")).toBeNull();

    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(highlightCalls).toEqual([{ code: sql, lang: "sql" }]);
    expect(container.querySelector("pre")?.textContent).toContain("WITH users");
    expect(container.innerHTML).toContain('data-highlight-lang="sql"');
    expect(container.querySelector("pre button")).toBeTruthy();

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("persists expanded state across row re-renders", async () => {
    const row = (
      <ToolActivityRow
        activity={activity("Bash", {
          toolUseId: "stable-tool-id",
          inputJson: JSON.stringify({ command: "echo one" }),
        })}
        searchQuery=""
      />
    );
    const container = await render(row);
    const toggle = container.querySelector("button") as HTMLButtonElement;

    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      mountedRoots[0].render(row);
    });

    const toggleAfterRender = container.querySelector("button") as HTMLButtonElement;
    expect(toggleAfterRender.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("pre")?.textContent).toContain("echo one");
  });

  it("renders single-field non-code inputs as plain monospace details", async () => {
    const filePath = "/repo/src/ui.tsx";
    const container = await render(
      <ToolActivityRow
        activity={activity("Read", {
          inputJson: JSON.stringify({ file_path: filePath }),
        })}
        searchQuery=""
      />,
    );

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });

    expect(highlightCalls).toEqual([]);
    expect(container.querySelector("pre")?.textContent).toBe(filePath);
    expect(container.querySelector("code")?.className).toBe("");
  });

  it("renders structured non-code inputs as highlighted pretty JSON", async () => {
    const input = { pattern: "*.tsx", path: "/repo/src" };
    const pretty = JSON.stringify(input, null, 2);
    const container = await render(
      <ToolActivityRow
        activity={activity("Glob", {
          inputJson: JSON.stringify(input),
        })}
        searchQuery=""
      />,
    );

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(highlightCalls).toEqual([{ code: pretty, lang: "json" }]);
    expect(container.querySelector("pre")?.textContent).toContain('"pattern"');
    expect(container.innerHTML).toContain('data-highlight-lang="json"');
  });

  it("renders Skill invocations as a '<skill> activated' marker without a chevron", async () => {
    const container = await render(
      <ToolActivityRow
        activity={activity("Skill", {
          inputJson: JSON.stringify({ skill: "commit-changes", args: "wip" }),
          summary: "commit-changes wip",
        })}
        searchQuery=""
      />,
    );

    expect(container.textContent).toContain("commit-changes");
    expect(container.textContent).toContain("activated");
    // No expand affordance and no raw "Skill" tool-name label.
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("falls back to the summary's first token when Skill input lacks a skill field", async () => {
    const container = await render(
      <ToolActivityRow
        activity={activity("Skill", {
          inputJson: "{}",
          summary: "rebase-on-main",
        })}
        searchQuery=""
      />,
    );

    expect(container.textContent).toContain("rebase-on-main activated");
  });

  it("renders edit details with real multiline strings instead of JSON escapes", async () => {
    const input = {
      file_path: "/repo/src/types.rs",
      old_string: "impl Cost {\n    fn label(&self) -> &str {\n        \"Sonnet\"\n    }\n}",
      new_string:
        "impl Cost {\n    fn label(&self) -> &str {\n        self.tier_label\n    }\n}",
    };
    const container = await render(
      <ToolActivityRow
        activity={activity("Edit", {
          inputJson: JSON.stringify(input),
        })}
        searchQuery=""
      />,
    );

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
      await Promise.resolve();
    });

    const text = container.querySelector("pre")?.textContent ?? "";
    expect(highlightCalls).toEqual([
      {
        code:
          'file_path: "/repo/src/types.rs"\n' +
          "old_string: |-\n" +
          "  impl Cost {\n" +
          "      fn label(&self) -> &str {\n" +
          '          "Sonnet"\n' +
          "      }\n" +
          "  }\n" +
          "new_string: |-\n" +
          "  impl Cost {\n" +
          "      fn label(&self) -> &str {\n" +
          "          self.tier_label\n" +
          "      }\n" +
          "  }",
        lang: "yaml",
      },
    ]);
    expect(text).toContain("old_string: |-");
    expect(text).toContain("new_string: |-");
    expect(text).toContain("self.tier_label");
    expect(text).not.toContain("\\n");
  });

  it("renders Codex fileChange details with the shared diff presentation", async () => {
    const container = await render(
      <ToolActivityRow
        activity={activity("Edit", {
          inputJson: JSON.stringify({
            changes: [
              {
                path: "src/app.ts",
                kind: "update",
                diff: ["@@ -1 +1 @@", "-old", "+new"].join("\n"),
              },
            ],
          }),
        })}
        searchQuery=""
      />,
    );

    expect(container.textContent).toContain("Editing");
    expect(container.textContent).toContain("src/app.ts");

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(highlightCalls).toEqual([
      {
        code: [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
        lang: "diff",
      },
    ]);
    expect(container.querySelector("pre")?.textContent).toContain(
      "diff --git a/src/app.ts b/src/app.ts",
    );
  });
});
