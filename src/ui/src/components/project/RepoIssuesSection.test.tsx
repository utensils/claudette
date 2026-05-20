// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoIssuesSection } from "./RepoIssuesSection";
import { useRepoOpenIssues } from "../../hooks/useRepoOpenIssues";
import type { Issue, RepoIssuesPayload } from "../../types/plugin";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../hooks/useRepoOpenIssues", () => ({
  useRepoOpenIssues: vi.fn(),
}));
vi.mock("../../services/tauri", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const mockedHook = vi.mocked(useRepoOpenIssues);

function makeIssue(n: number): Issue {
  return {
    number: n,
    title: `Issue ${n}`,
    url: `https://example.com/issues/${n}`,
    state: "open",
    author: "octocat",
    labels: [],
    comment_count: 0,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-10T00:00:00Z",
  };
}

function makePayload(over: Partial<RepoIssuesPayload>): RepoIssuesPayload {
  return {
    issues: [],
    fetched_at: "2026-05-19T00:00:00Z",
    error: null,
    unsupported: false,
    provider: "scm-github",
    ...over,
  };
}

const roots: Root[] = [];

function render(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<RepoIssuesSection repoId="repo-1" />);
  });
  return container;
}

/** The section renders collapsed; click the header to expand the body. */
function expand(container: HTMLElement) {
  const header = container.querySelector("button");
  act(() => {
    header?.click();
  });
}

beforeEach(() => {
  mockedHook.mockReset();
});

afterEach(() => {
  act(() => {
    roots.forEach((r) => r.unmount());
  });
  roots.length = 0;
  document.body.innerHTML = "";
});

describe("RepoIssuesSection error/cache handling", () => {
  it("renders cached rows AND a non-destructive banner when a refresh fails", () => {
    // Backend contract: on a transient provider failure it returns the
    // prior cached rows together with `error` set. The UI must keep the
    // rows visible — see the Codex peer-review fix.
    mockedHook.mockReturnValue({
      payload: makePayload({
        issues: [makeIssue(1), makeIssue(2)],
        error: "rate limited",
      }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);

    expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("Issue 1");
    expect(container.textContent).toContain("Issue 2");
    expect(container.textContent).toContain("showing cached results");
    // The destructive "Could not load issues." banner must NOT appear
    // when we have cached rows to fall back on.
    expect(container.textContent).not.toContain("Could not load issues.");
  });

  it("replaces the list with an error banner when there is nothing cached", () => {
    mockedHook.mockReturnValue({
      payload: makePayload({ issues: [], error: "rate limited" }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);

    expect(container.textContent).toContain("Could not load issues.");
    expect(container.textContent).not.toContain("showing cached results");
  });

  it("shows the unsupported hint when the provider lacks list_issues", () => {
    mockedHook.mockReturnValue({
      payload: makePayload({ unsupported: true }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);
    expect(container.textContent).toContain(
      "Issues are not supported by this provider",
    );
  });

  it("shows the empty state when there are no issues and no error", () => {
    mockedHook.mockReturnValue({
      payload: makePayload({ issues: [] }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);
    expect(container.textContent).toContain("No open issues.");
  });

  it("renders the open-count badge in the collapsed header", () => {
    mockedHook.mockReturnValue({
      payload: makePayload({ issues: [makeIssue(1), makeIssue(2), makeIssue(3)] }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    // Header badge is visible without expanding.
    expect(container.textContent).toContain("3");
  });
});
