import { describe, expect, it } from "vitest";
import {
  isWorkflowResume,
  workflowDescription,
  workflowDisplayName,
  workflowLaunchTaskId,
} from "./workflowMeta";

/** Shape captured from a real Workflow tool_use. */
const INLINE_SCRIPT = `export const meta = {
  name: 'verify-sonnet-5-transition',
  description: 'Adversarially verify the Sonnet 5 model-transition diff',
  phases: [
    { title: 'Review' },
    { title: 'Synthesize' },
  ],
}

const DIMENSIONS = [{ name: 'completeness' }]
phase('Review')
await agent('do the thing', { label: 'review:completeness' })
`;

function input(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe("workflowDisplayName", () => {
  it("reads meta.name from an inline script", () => {
    expect(workflowDisplayName(input({ script: INLINE_SCRIPT }))).toBe(
      "verify-sonnet-5-transition",
    );
  });

  it("prefers an explicit name over the script's meta", () => {
    expect(
      workflowDisplayName(input({ name: "saved-review", script: INLINE_SCRIPT })),
    ).toBe("saved-review");
  });

  it("does not mistake a later `name:` in the script body for the workflow name", () => {
    const script = `export const meta = { description: 'no name here' }
const DIMENSIONS = [{ name: 'completeness' }]`;
    // No name in meta and no scriptPath — must fall back, not pick up
    // the DIMENSIONS entry.
    expect(workflowDisplayName(input({ script }))).toBe("Workflow");
  });

  it("survives a brace inside a meta string value", () => {
    const script = `export const meta = {
  description: 'emit {n} findings per {dimension}',
  name: 'braced',
}
const DIMENSIONS = [{ name: 'wrong' }]`;
    expect(workflowDisplayName(input({ script }))).toBe("braced");
  });

  it("reads through nested phase objects to a name declared last", () => {
    const script = `export const meta = {
  phases: [{ title: 'Review' }, { title: 'Verify' }],
  name: 'nested-last',
}
const DIMENSIONS = [{ name: 'wrong' }]`;
    expect(workflowDisplayName(input({ script }))).toBe("nested-last");
  });

  it("falls back rather than hanging when the meta literal never closes", () => {
    expect(
      workflowDisplayName(input({ script: "export const meta = { name: 'x'" })),
    ).toBe("Workflow");
  });

  it("falls back to the script path basename, stripping the run-id suffix", () => {
    expect(
      workflowDisplayName(
        input({
          scriptPath:
            "/Users/x/.claude/projects/p/s/workflows/scripts/safety-review-wf_e170b89e-638.js",
        }),
      ),
    ).toBe("safety-review");
  });

  it("handles a Windows-style script path", () => {
    expect(
      workflowDisplayName(input({ scriptPath: "C:\\claude\\scripts\\audit.js" })),
    ).toBe("audit");
  });

  it("handles double-quoted and backtick meta values", () => {
    expect(
      workflowDisplayName(input({ script: `export const meta = { name: "dq-flow" }` })),
    ).toBe("dq-flow");
    expect(
      workflowDisplayName(input({ script: "export const meta = { name: `bt-flow` }" })),
    ).toBe("bt-flow");
  });

  it("returns a usable label for malformed or empty input", () => {
    expect(workflowDisplayName("not json")).toBe("Workflow");
    expect(workflowDisplayName("")).toBe("Workflow");
    expect(workflowDisplayName(input({}))).toBe("Workflow");
    expect(workflowDisplayName(input({ name: "   " }))).toBe("Workflow");
    // A JSON array parses fine but isn't an input object.
    expect(workflowDisplayName("[1,2]")).toBe("Workflow");
  });
});

describe("workflowDescription", () => {
  it("reads meta.description from an inline script", () => {
    expect(workflowDescription(input({ script: INLINE_SCRIPT }))).toBe(
      "Adversarially verify the Sonnet 5 model-transition diff",
    );
  });

  it("is null when the workflow was launched by name with no script", () => {
    expect(workflowDescription(input({ name: "saved-review" }))).toBeNull();
  });

  it("is null when the script has no meta block", () => {
    expect(workflowDescription(input({ script: "phase('Review')" }))).toBeNull();
  });
});

describe("isWorkflowResume", () => {
  it("detects a resumed run", () => {
    expect(
      isWorkflowResume(input({ scriptPath: "/tmp/x.js", resumeFromRunId: "wf_abc123" })),
    ).toBe(true);
  });

  it("is false for a fresh run", () => {
    expect(isWorkflowResume(input({ script: INLINE_SCRIPT }))).toBe(false);
    expect(isWorkflowResume("not json")).toBe(false);
  });
});

describe("workflowLaunchTaskId", () => {
  // Absence of a task id is what marks a run as never started, so the
  // positive cases have to be exactly right: a false negative resolves a live
  // run about a second after launch and kills its status pill.
  it("reads the id out of the launch announcement", () => {
    expect(
      workflowLaunchTaskId(
        "Workflow launched in background. Task ID: w998sx0z2\nSummary: investigate the thing\nTranscript dir: /tmp/x",
      ),
    ).toBe("w998sx0z2");
  });

  it("strips a trailing sentence period", () => {
    expect(
      workflowLaunchTaskId("Workflow launched in background. Task ID: wf_abc123."),
    ).toBe("wf_abc123");
  });

  it("finds the announcement embedded in surrounding text", () => {
    expect(
      workflowLaunchTaskId(
        "Started.\nWorkflow launched in background. Task ID: w1\nRun ID: wf_x",
      ),
    ).toBe("w1");
  });

  it("returns null when no task was launched", () => {
    expect(workflowLaunchTaskId("")).toBeNull();
    expect(workflowLaunchTaskId("Error: script failed to parse")).toBeNull();
    expect(workflowLaunchTaskId("Workflow launched in background. Task ID:")).toBeNull();
    // A background Bash binding must not be mistaken for a workflow launch.
    expect(
      workflowLaunchTaskId(
        "Command running in background with ID: task_1. Output is being written to: /tmp/o",
      ),
    ).toBeNull();
  });

  // Mirrors `parses_workflow_task_binding` in src/agent/background.rs — the
  // two read the same announcement, and Rust arms the background-task wake
  // off it. Drifting apart would break the wake and this in one release.
  it("agrees with the Rust parser's fixtures", () => {
    expect(
      workflowLaunchTaskId(
        "Workflow launched in background. Task ID: w998sx0z2\nSummary: investigate the thing\nTranscript dir: /tmp/x",
      ),
    ).toBe("w998sx0z2");
    expect(
      workflowLaunchTaskId("Workflow launched in background. Task ID: wf_abc123."),
    ).toBe("wf_abc123");
  });
});
