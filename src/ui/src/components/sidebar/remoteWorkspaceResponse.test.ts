import { describe, it, expect } from "vitest";
import { extractRemoteWorkspace } from "./remoteWorkspaceResponse";

describe("extractRemoteWorkspace", () => {
  // Regression: Phase 1 changed the server's create_workspace response
  // from a bare Workspace row to {workspace, default_session_id, ...}
  // and the sidebar previously checked `result.id` at the top level,
  // which started failing with "Remote server returned an invalid
  // workspace" for every remote-driven create.
  it("unwraps the new {workspace, default_session_id} shape", () => {
    const payload = {
      workspace: {
        id: "ws-1",
        repository_id: "repo-1",
        name: "feature",
        branch_name: "user/feature",
        worktree_path: "/tmp/feature",
        status: "Active",
        agent_status: "Idle",
        status_line: "",
        created_at: "1700000000",
        sort_order: 0,
      },
      default_session_id: "sess-1",
      setup_result: null,
    };
    const got = extractRemoteWorkspace(payload);
    expect(got).not.toBeNull();
    expect(got?.id).toBe("ws-1");
    expect(got?.branch_name).toBe("user/feature");
  });

  it("accepts the legacy bare Workspace shape (older servers)", () => {
    const payload = {
      id: "ws-2",
      repository_id: "repo-2",
      name: "legacy",
      branch_name: "user/legacy",
      worktree_path: "/tmp/legacy",
      status: "Active",
      agent_status: "Idle",
      status_line: "",
      created_at: "1700000001",
      sort_order: 0,
    };
    const got = extractRemoteWorkspace(payload);
    expect(got?.id).toBe("ws-2");
  });

  it("returns null for null", () => {
    expect(extractRemoteWorkspace(null)).toBeNull();
  });

  it("returns null for an object missing both shapes", () => {
    expect(extractRemoteWorkspace({ foo: "bar" })).toBeNull();
  });

  it("returns null when wrapped workspace lacks an id", () => {
    expect(extractRemoteWorkspace({ workspace: { name: "x" } })).toBeNull();
  });

  it("returns null when workspace is missing required fields beyond id", () => {
    // A future-server response containing just `id` (or a malformed
    // legacy row) would have previously cast through and produced
    // runtime undefined for downstream code reading repository_id /
    // branch_name / status / name. The looksLikeWorkspace guard
    // rejects partial shapes up front.
    expect(extractRemoteWorkspace({ id: "ws-x" })).toBeNull();
    expect(
      extractRemoteWorkspace({ id: "ws-x", repository_id: "r", name: "n" }),
    ).toBeNull();
  });

  it("returns null when fields the dashboard sort relies on are missing", () => {
    // Dashboard does `ws.created_at.localeCompare(...)` and the
    // reorder slice does numeric arithmetic on `sort_order`, so a
    // payload that satisfies the basic id/name/status check but omits
    // these would crash downstream — the guard rejects it up front.
    const almost = {
      id: "ws-y",
      repository_id: "r",
      name: "n",
      branch_name: "b",
      worktree_path: "/tmp/n",
      status: "Active",
      agent_status: "Idle",
      status_line: "",
      // missing: created_at, sort_order
    };
    expect(extractRemoteWorkspace(almost)).toBeNull();
    expect(
      extractRemoteWorkspace({ ...almost, created_at: "1700000002" }),
    ).toBeNull(); // still missing sort_order
  });

  it("returns null for a primitive", () => {
    expect(extractRemoteWorkspace("ws-1")).toBeNull();
    expect(extractRemoteWorkspace(42)).toBeNull();
  });
});
