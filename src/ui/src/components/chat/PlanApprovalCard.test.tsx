// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanApproval } from "../../stores/useAppStore";
import { useAppStore } from "../../stores/useAppStore";
import { PlanApprovalCard } from "./PlanApprovalCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const serviceMocks = vi.hoisted(() => ({
  readPlanFile: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  openInEditor: vi.fn(),
  sendRemoteCommand: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../../services/tauri", () => ({
  readPlanFile: serviceMocks.readPlanFile,
  listWorkspaceFiles: serviceMocks.listWorkspaceFiles,
  openInEditor: serviceMocks.openInEditor,
  sendRemoteCommand: serviceMocks.sendRemoteCommand,
  openUrl: serviceMocks.openUrl,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const WS_ID = "ws-tax";
const WORKTREE = "/Users/me/.claudette/workspaces/nyc-real-estate/fix-tax";
const ABSOLUTE_FILE =
  "/Users/me/.claudette/workspaces/nyc-real-estate/fix-tax/app/services/tax_bill_stage_dispatcher.rb";

const roots: Root[] = [];
const containers: HTMLElement[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((node) =>
    node.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button containing "${label}" not found`);
  }
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function makeApproval(overrides: Partial<PlanApproval> = {}): PlanApproval {
  return {
    sessionId: "session-1",
    toolUseId: "plan-1",
    planFilePath: "/tmp/plan.md",
    allowedPrompts: [],
    ...overrides,
  };
}

beforeEach(() => {
  serviceMocks.readPlanFile.mockReset();
  serviceMocks.listWorkspaceFiles.mockReset();
  serviceMocks.openInEditor.mockReset();
  serviceMocks.sendRemoteCommand.mockReset();
  serviceMocks.openUrl.mockReset();
  serviceMocks.listWorkspaceFiles.mockResolvedValue([
    {
      path: "app/services/tax_bill_stage_dispatcher.rb",
      is_directory: false,
    },
  ]);
  useAppStore.setState({
    workspaces: [
      {
        id: WS_ID,
        name: "fix-tax",
        repository_id: "repo-1",
        branch_name: "fix",
        worktree_path: WORKTREE,
        sort_order: 0,
        created_at: "",
        status: "Active",
        agent_status: "Idle",
        status_line: "",
        input_values: null,
        remote_connection_id: null,
      },
    ],
    fileTabsByWorkspace: {},
    activeFileTabByWorkspace: {},
    fileRevealTargetByWorkspace: {},
    fileBuffers: {},
    fileTreeRefreshNonceByWorkspace: {},
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await act(async () => root.unmount());
  }
  for (const container of containers.splice(0)) container.remove();
});

describe("PlanApprovalCard file links", () => {
  it("opens absolute file paths in Monaco instead of the OS default editor", async () => {
    serviceMocks.readPlanFile.mockResolvedValue(
      `## Critical Files for Implementation\n\n${ABSOLUTE_FILE}\n`,
    );

    const container = await render(
      <PlanApprovalCard
        approval={makeApproval()}
        workspaceId={WS_ID}
        onRespond={() => {}}
      />,
    );

    // Expand the plan so the markdown renders and rehype wraps the absolute
    // path in a `claudettepath:` autolink.
    await click(buttonNamed(container, "plan_approval_view_plan"));
    await flushMicrotasks();
    await flushMicrotasks();

    const fileLink = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button.cc-file-path-link"),
    ).find((b) => b.title === "app/services/tax_bill_stage_dispatcher.rb");
    expect(fileLink, "expected absolute path to render as a Monaco-bound link").toBeTruthy();

    await click(fileLink!);

    // Monaco tab opened, OS default editor NOT invoked.
    expect(serviceMocks.openInEditor).not.toHaveBeenCalled();
    const tabs = useAppStore.getState().fileTabsByWorkspace[WS_ID];
    expect(tabs).toEqual(["app/services/tax_bill_stage_dispatcher.rb"]);
    expect(
      useAppStore.getState().activeFileTabByWorkspace[WS_ID],
    ).toBe("app/services/tax_bill_stage_dispatcher.rb");
  });

  it("preserves line:column targets when revealing the file in Monaco", async () => {
    serviceMocks.readPlanFile.mockResolvedValue(
      `Open ${ABSOLUTE_FILE}:42:7 to start.\n`,
    );

    const container = await render(
      <PlanApprovalCard
        approval={makeApproval()}
        workspaceId={WS_ID}
        onRespond={() => {}}
      />,
    );

    await click(buttonNamed(container, "plan_approval_view_plan"));
    await flushMicrotasks();
    await flushMicrotasks();

    const fileLink = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button.cc-file-path-link"),
    ).find((b) => b.title?.startsWith("app/services/tax_bill_stage_dispatcher.rb"));
    expect(fileLink).toBeTruthy();
    await click(fileLink!);

    expect(serviceMocks.openInEditor).not.toHaveBeenCalled();
    const reveal = useAppStore.getState().fileRevealTargetByWorkspace[WS_ID];
    expect(reveal?.path).toBe("app/services/tax_bill_stage_dispatcher.rb");
    expect(reveal?.startLine).toBe(42);
    expect(reveal?.startColumn).toBe(7);
  });

  it("leaves out-of-project absolute paths to the OS default editor", async () => {
    // A plan that references a file genuinely outside any Claudette worktree
    // (e.g. `/tmp/notes.md`) still has no Monaco target, so the fallback
    // openInEditor path must remain reachable for those clicks. This pins
    // the behavior so a future fix to the in-project path doesn't
    // accidentally trap out-of-project links too.
    const backtick = "`";
    serviceMocks.readPlanFile.mockResolvedValue(
      `See ${backtick}/tmp/notes.md${backtick} for context.\n`,
    );

    const container = await render(
      <PlanApprovalCard
        approval={makeApproval()}
        workspaceId={WS_ID}
        onRespond={() => {}}
      />,
    );

    await click(buttonNamed(container, "plan_approval_view_plan"));
    await flushMicrotasks();
    await flushMicrotasks();

    const fileLink = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button.cc-file-path-link"),
    ).find((b) => b.title === "/tmp/notes.md");
    expect(fileLink, "expected /tmp/notes.md to render as a file-path button").toBeTruthy();
    await click(fileLink!);

    expect(serviceMocks.openInEditor).toHaveBeenCalledTimes(1);
    expect(serviceMocks.openInEditor).toHaveBeenCalledWith("/tmp/notes.md");
    expect(useAppStore.getState().fileTabsByWorkspace[WS_ID] ?? []).toEqual([]);
  });
});
