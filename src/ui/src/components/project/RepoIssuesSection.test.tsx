// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoIssuesSection } from "./RepoIssuesSection";
import { useRepoOpenIssues } from "../../hooks/useRepoOpenIssues";
import { openUrl } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import type { Issue, RepoIssuesPayload } from "../../types/plugin";
import type { Workspace } from "../../types/workspace";

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

function makeWorkspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    repository_id: "repo-1",
    name: "fix-the-thing",
    branch_name: "james/fix-the-thing",
    worktree_path: "/tmp/ws",
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "1700000000",
    sort_order: 0,
    input_values: null,
    remote_connection_id: null,
    ...over,
  };
}

beforeEach(() => {
  mockedHook.mockReset();
  // Reset the link/workspace slices so a test that seeds them can't
  // leak grouping state into the others.
  useAppStore.setState({
    workspaceScmLinks: {},
    workspaces: [],
    projectViewIssuesPrsEnabled: false,
  });
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

  it("activates a row on Space as well as Enter (role=button a11y)", () => {
    mockedHook.mockReturnValue({
      payload: makePayload({ issues: [makeIssue(1)] }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);
    vi.mocked(openUrl).mockClear();

    const row = container.querySelector('[role="button"]');
    expect(row).toBeTruthy();
    act(() => {
      row?.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });
    expect(vi.mocked(openUrl)).toHaveBeenCalledWith(
      "https://example.com/issues/1",
    );
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

  it("splits dispatched issues into an 'In progress' group", () => {
    // Issue #2 has a live workspace; #1 and #3 do not. The section
    // only mounts with the project-view feature on, so mirror that.
    useAppStore.setState({
      projectViewIssuesPrsEnabled: true,
      workspaces: [makeWorkspace({ id: "ws-1", name: "fixer" })],
      workspaceScmLinks: {
        "ws-1": {
          workspace_id: "ws-1",
          repo_id: "repo-1",
          kind: "issue",
          number: 2,
          url: "https://example.com/issues/2",
          title: "Issue 2",
          created_at: "2026-05-20 10:00:00",
        },
      },
    });
    mockedHook.mockReturnValue({
      payload: makePayload({
        issues: [makeIssue(1), makeIssue(2), makeIssue(3)],
      }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);

    // Both group headers appear, and the dispatched issue's workspace
    // badge is rendered.
    expect(container.textContent).toContain("In progress");
    expect(container.textContent).toContain("Open");
    expect(container.textContent).toContain("fixer");
  });

  it("renders a flat list (no group headers) when nothing is dispatched", () => {
    mockedHook.mockReturnValue({
      payload: makePayload({ issues: [makeIssue(1), makeIssue(2)] }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);
    expect(container.textContent).not.toContain("In progress");
  });
});
