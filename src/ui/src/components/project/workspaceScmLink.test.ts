import { describe, it, expect } from "vitest";
import { resolveWorkspaceLink } from "./workspaceScmLink";
import type { Workspace } from "../../types/workspace";
import type { WorkspaceScmLink } from "../../types/plugin";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    repository_id: "repo-1",
    name: "slender-mint",
    branch_name: "james/slender-mint",
    worktree_path: "/tmp/slender-mint",
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "1700000000",
    sort_order: 0,
    remote_connection_id: null,
    ...overrides,
  };
}

function makeLink(overrides: Partial<WorkspaceScmLink> = {}): WorkspaceScmLink {
  return {
    workspace_id: "ws-1",
    repo_id: "repo-1",
    kind: "issue",
    number: 898,
    url: "https://github.com/utensils/claudette/issues/898",
    title: "persist issue/PR -> workspace association",
    created_at: "2026-05-20 15:30:00",
    ...overrides,
  };
}

const TARGET = { repoId: "repo-1", kind: "issue", number: 898 } as const;

describe("resolveWorkspaceLink", () => {
  it("resolves to an active linked workspace", () => {
    const links = { "ws-1": makeLink() };
    const workspaces = [makeWorkspace()];
    expect(resolveWorkspaceLink(links, workspaces, TARGET)).toEqual({
      workspaceId: "ws-1",
      workspaceName: "slender-mint",
      link: links["ws-1"],
    });
  });

  it("returns null when no link matches the target item", () => {
    const links = { "ws-1": makeLink({ number: 1 }) };
    const workspaces = [makeWorkspace()];
    expect(resolveWorkspaceLink(links, workspaces, TARGET)).toBeNull();
  });

  it("distinguishes issue #N from PR #N with the same number", () => {
    const links = { "ws-1": makeLink({ kind: "pr" }) };
    const workspaces = [makeWorkspace()];
    expect(resolveWorkspaceLink(links, workspaces, TARGET)).toBeNull();
  });

  it("scopes the match to the target repo", () => {
    const links = { "ws-1": makeLink({ repo_id: "repo-other" }) };
    const workspaces = [makeWorkspace()];
    expect(resolveWorkspaceLink(links, workspaces, TARGET)).toBeNull();
  });

  it("returns null when the linked workspace was hard-deleted", () => {
    // The link row outlives the workspace only in-session — the FK
    // cascade drops it on next boot. The read-side filter must cover it.
    const links = { "ws-1": makeLink() };
    expect(resolveWorkspaceLink(links, [], TARGET)).toBeNull();
  });

  it("hides the badge when the linked workspace is archived", () => {
    const links = { "ws-1": makeLink() };
    const workspaces = [makeWorkspace({ status: "Archived" })];
    expect(resolveWorkspaceLink(links, workspaces, TARGET)).toBeNull();
  });

  it("does not let a stale link shadow a newer active one for the same item", () => {
    // The right-click menu keeps "Send to new workspace" available even
    // when a link exists, so an item can carry several links. An older
    // archived/deleted one must not hide the active workspace.
    const links = {
      "ws-old": makeLink({
        workspace_id: "ws-old",
        created_at: "2026-05-19 09:00:00",
      }),
      "ws-new": makeLink({
        workspace_id: "ws-new",
        created_at: "2026-05-20 15:30:00",
      }),
    };
    const workspaces = [
      makeWorkspace({ id: "ws-old", status: "Archived" }),
      makeWorkspace({ id: "ws-new", name: "fresh-start", status: "Active" }),
    ];
    expect(resolveWorkspaceLink(links, workspaces, TARGET)).toEqual({
      workspaceId: "ws-new",
      workspaceName: "fresh-start",
      link: links["ws-new"],
    });
  });

  it("prefers the most recently created link when several are active", () => {
    const links = {
      "ws-old": makeLink({
        workspace_id: "ws-old",
        created_at: "2026-05-19 09:00:00",
      }),
      "ws-new": makeLink({
        workspace_id: "ws-new",
        created_at: "2026-05-20 15:30:00",
      }),
    };
    const workspaces = [
      makeWorkspace({ id: "ws-old", name: "first-try", status: "Active" }),
      makeWorkspace({ id: "ws-new", name: "second-try", status: "Active" }),
    ];
    expect(resolveWorkspaceLink(links, workspaces, TARGET)?.workspaceId).toBe(
      "ws-new",
    );
  });
});
