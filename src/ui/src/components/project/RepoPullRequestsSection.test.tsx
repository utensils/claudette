// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoPullRequestsSection } from "./RepoPullRequestsSection";
import { useRepoOpenPullRequests } from "../../hooks/useRepoOpenPullRequests";
import type { PullRequest, RepoPullRequestsPayload } from "../../types/plugin";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../hooks/useRepoOpenPullRequests", () => ({
  useRepoOpenPullRequests: vi.fn(),
}));
vi.mock("../../services/tauri", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../hooks/useCreateWorkspace", () => ({
  createWorkspaceOrchestrated: vi.fn().mockResolvedValue(null),
}));

const mockedHook = vi.mocked(useRepoOpenPullRequests);

function makePr(n: number): PullRequest {
  return {
    number: n,
    title: `PR ${n}`,
    url: `https://example.com/pull/${n}`,
    state: "open",
    author: "octocat",
    branch: `feat/${n}`,
    base: "main",
    draft: false,
    ci_status: null,
  };
}

function makePayload(
  over: Partial<RepoPullRequestsPayload>,
): RepoPullRequestsPayload {
  return {
    pull_requests: [],
    scope: "open",
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
    root.render(<RepoPullRequestsSection repoId="repo-1" />);
  });
  return container;
}

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

describe("RepoPullRequestsSection error/cache handling", () => {
  it("keeps cached PR rows visible behind a non-destructive banner on refresh failure", () => {
    mockedHook.mockReturnValue({
      payload: makePayload({
        pull_requests: [makePr(10), makePr(11)],
        error: "rate limited",
      }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);

    expect(container.textContent).toContain("PR 10");
    expect(container.textContent).toContain("PR 11");
    expect(container.textContent).toContain("showing cached results");
    expect(container.textContent).not.toContain(
      "Could not load pull requests.",
    );
  });

  it("replaces the list with an error banner when nothing is cached", () => {
    mockedHook.mockReturnValue({
      payload: makePayload({ pull_requests: [], error: "boom" }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);
    expect(container.textContent).toContain("Could not load pull requests.");
  });

  it("renders the honest 'New workspace in this repo' context-menu label", () => {
    mockedHook.mockReturnValue({
      payload: makePayload({ pull_requests: [makePr(10)] }),
      loading: false,
      refresh: vi.fn(),
    });
    const container = render();
    expand(container);

    // Right-click the PR row to open the context menu.
    const row = container.querySelector('[role="button"]');
    expect(row).toBeTruthy();
    act(() => {
      row?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
      );
    });
    const menuText = document.body.textContent ?? "";
    // The action no longer claims to check out the PR branch — it only
    // creates a workspace on the repo's default branch.
    expect(menuText).toContain("New workspace in this repo");
    expect(menuText).not.toContain("Create workspace for this branch");
  });
});
