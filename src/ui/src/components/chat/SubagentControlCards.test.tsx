// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentControlCards } from "./SubagentControlCards";
import { useAppStore } from "../../stores/useAppStore";
import { getPendingSubagentControls, type SubagentControl } from "../../services/tauri/subagentRuns";
import { submitAgentAnswer } from "../../services/tauri";
import { subagentSessionKey } from "../../types/subagent";

vi.mock("../../services/tauri", async (original) => ({ ...await original<typeof import("../../services/tauri")>(), submitAgentAnswer: vi.fn(), submitAgentApproval: vi.fn() }));
vi.mock("../../services/tauri/subagentRuns", () => ({ getPendingSubagentControls: vi.fn() }));

const key = subagentSessionKey("peer", "chat");
const makeControl = (id: string): SubagentControl => ({
  tool_use_id: id, tool_name: "AskUserQuestion",
  input: { subagent_run_id: id, questions: [{ question: `Proceed with ${id}?`, options: [{ label: "Yes" }] }] },
});

describe("child approval cards", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useAppStore.setState({ subagentControls: {}, subagentRuns: {} });
  });

  it("accepts either concurrent request while the parent is idle", async () => {
    const store = useAppStore.getState();
    for (const id of ["alpha", "beta"]) store.updateSubagentControl("peer", "chat", id, makeControl(id));
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(<SubagentControlCards sessionId="chat" connectionId="peer" setError={vi.fn()} />));
    expect(container.textContent).toContain("Proceed with alpha?");
    expect(container.textContent).toContain("Proceed with beta?");
    // The second card can be answered first.
    const second = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent?.includes("Yes"))[1];
    await act(async () => { second.click(); });
    expect(submitAgentAnswer).toHaveBeenCalledWith("chat", "beta", { "Proceed with beta?": "Yes" }, "peer");
    expect(container.textContent).not.toContain("Proceed with beta?");
    expect(container.textContent).toContain("Proceed with alpha?");
    await act(async () => root.unmount());
  });

  it("merges live arrivals and resolutions over an in-flight snapshot", async () => {
    let resolve!: (rows: SubagentControl[]) => void;
    vi.mocked(getPendingSubagentControls).mockReturnValue(new Promise((done) => { resolve = done; }));
    const store = useAppStore.getState();
    const loading = store.reloadSubagentControls("peer", "chat");
    store.updateSubagentControl("peer", "chat", "closed");
    store.updateSubagentControl("peer", "chat", "opened", makeControl("opened"));
    resolve([makeControl("closed"), makeControl("unchanged")]);
    await loading;
    expect(useAppStore.getState().subagentControls[key].map((entry) => entry.tool_use_id)).toEqual(["unchanged", "opened"]);
  });
});
