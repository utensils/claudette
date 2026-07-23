import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";
import type { CompletedTurn, ToolActivity } from "./useAppStore";
import type { WorkflowProgressEntry } from "../types/workflow";

const SESSION = "session-1";

function workflowActivity(
  toolUseId = "toolu_wf1",
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId,
    toolName: "Workflow",
    inputJson: JSON.stringify({ script: "export const meta = { name: 'x' }" }),
    resultText: "Workflow launched in background. Task ID: w4stpeffj",
    collapsed: false,
    summary: "x",
    agentStatus: "running",
    ...overrides,
  };
}

function completedTurn(
  id: string,
  activities: ToolActivity[],
): CompletedTurn {
  return {
    id,
    activities,
    messageCount: 1,
    collapsed: true,
    afterMessageIndex: 1,
  };
}

const TREE: WorkflowProgressEntry[] = [
  { type: "workflow_phase", index: 1, title: "Review" },
  {
    type: "workflow_agent",
    index: 1,
    label: "review:bugs",
    state: "done",
  },
];

beforeEach(() => {
  useAppStore.setState({ toolActivities: {}, completedTurns: {} });
});

describe("updateToolActivity — workflow progress after the turn ends", () => {
  it("updates the live activity when one matches", () => {
    useAppStore.setState({
      toolActivities: { [SESSION]: [workflowActivity()] },
    });

    useAppStore
      .getState()
      .updateToolActivity(SESSION, "toolu_wf1", {
        workflowProgress: TREE,
        agentStatus: "completed",
      });

    const activity = useAppStore.getState().toolActivities[SESSION][0];
    expect(activity.workflowProgress).toEqual(TREE);
    expect(activity.agentStatus).toBe("completed");
  });

  // The case this fallback exists for: a Workflow's tool_result lands at
  // launch, the agent finishes its turn, and the run keeps emitting
  // progress for minutes. Those updates arrive after `finalizeTurn` has
  // moved the activity into `completedTurns`.
  it("falls back to a completed turn when the activity is no longer live", () => {
    useAppStore.setState({
      toolActivities: { [SESSION]: [] },
      completedTurns: {
        [SESSION]: [completedTurn("turn-1", [workflowActivity()])],
      },
    });

    useAppStore
      .getState()
      .updateToolActivity(SESSION, "toolu_wf1", {
        workflowProgress: TREE,
        agentStatus: "completed",
      });

    const activity =
      useAppStore.getState().completedTurns[SESSION][0].activities[0];
    expect(activity.workflowProgress).toEqual(TREE);
    expect(activity.agentStatus).toBe("completed");
  });

  it("finds the activity in an older turn, not just the newest", () => {
    useAppStore.setState({
      completedTurns: {
        [SESSION]: [
          completedTurn("turn-1", [workflowActivity()]),
          completedTurn("turn-2", [
            workflowActivity("toolu_other", { toolName: "Bash" }),
          ]),
        ],
      },
    });

    useAppStore
      .getState()
      .updateToolActivity(SESSION, "toolu_wf1", { agentStatus: "completed" });

    const turns = useAppStore.getState().completedTurns[SESSION];
    expect(turns[0].activities[0].agentStatus).toBe("completed");
    expect(turns[1].activities[0].agentStatus).toBe("running");
  });

  it("prefers the live activity over a same-id completed one", () => {
    useAppStore.setState({
      toolActivities: { [SESSION]: [workflowActivity()] },
      completedTurns: {
        [SESSION]: [completedTurn("turn-1", [workflowActivity()])],
      },
    });

    useAppStore
      .getState()
      .updateToolActivity(SESSION, "toolu_wf1", { agentStatus: "completed" });

    expect(useAppStore.getState().toolActivities[SESSION][0].agentStatus).toBe(
      "completed",
    );
    expect(
      useAppStore.getState().completedTurns[SESSION][0].activities[0]
        .agentStatus,
    ).toBe("running");
  });

  it("is a no-op when the id matches nothing anywhere", () => {
    const before = {
      toolActivities: { [SESSION]: [workflowActivity()] },
      completedTurns: {
        [SESSION]: [completedTurn("turn-1", [workflowActivity("toolu_a")])],
      },
    };
    useAppStore.setState(before);

    useAppStore
      .getState()
      .updateToolActivity(SESSION, "toolu_missing", { agentStatus: "completed" });

    expect(useAppStore.getState().toolActivities[SESSION][0].agentStatus).toBe(
      "running",
    );
    expect(
      useAppStore.getState().completedTurns[SESSION][0].activities[0]
        .agentStatus,
    ).toBe("running");
  });

  // Zustand shallow-merges an updater's return value, so returning `{}` on a
  // miss still allocates a new *top-level* state object (via
  // `Object.assign({}, state, {})`) and notifies every subscriber. Returning
  // the existing state instead is `Object.is`-equal, so Zustand skips the
  // merge entirely and the state reference is preserved — a genuine no-op on
  // the many progress ticks that match nothing here.
  it("preserves the top-level state reference on a miss", () => {
    useAppStore.setState({
      toolActivities: { [SESSION]: [workflowActivity()] },
      completedTurns: {
        [SESSION]: [completedTurn("turn-1", [workflowActivity("toolu_a")])],
      },
    });
    const before = useAppStore.getState();

    before.updateToolActivity(SESSION, "toolu_missing", {
      agentStatus: "completed",
    });

    expect(useAppStore.getState()).toBe(before);
  });

  it("does not disturb sibling activities in the same completed turn", () => {
    useAppStore.setState({
      completedTurns: {
        [SESSION]: [
          completedTurn("turn-1", [
            workflowActivity("toolu_a", { toolName: "Read" }),
            workflowActivity(),
            workflowActivity("toolu_b", { toolName: "Edit" }),
          ]),
        ],
      },
    });

    useAppStore
      .getState()
      .updateToolActivity(SESSION, "toolu_wf1", { workflowProgress: TREE });

    const activities =
      useAppStore.getState().completedTurns[SESSION][0].activities;
    expect(activities[0].workflowProgress).toBeUndefined();
    expect(activities[1].workflowProgress).toEqual(TREE);
    expect(activities[2].workflowProgress).toBeUndefined();
  });
});
