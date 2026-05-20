// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/useAppStore";
import {
  buildModelSubmenuItems,
  renderStarterPrompt,
  sendToNewWorkspace,
  type SendToNewWorkspaceArgs,
} from "./sendToNewWorkspace";
import { createWorkspaceOrchestrated } from "../../hooks/useCreateWorkspace";
import { applySelectedModel } from "../chat/applySelectedModel";
import { createWorkspaceScmLink, sendChatMessage } from "../../services/tauri";
import type { Model } from "../chat/modelRegistry";
import type { WorkspaceScmLink } from "../../types/plugin";

vi.mock("../../hooks/useCreateWorkspace", () => ({
  createWorkspaceOrchestrated: vi.fn(),
}));
vi.mock("../chat/applySelectedModel", () => ({
  applySelectedModel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/tauri", () => ({
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  createWorkspaceScmLink: vi.fn(),
}));

const mockedCreate = vi.mocked(createWorkspaceOrchestrated);
const mockedApplyModel = vi.mocked(applySelectedModel);
const mockedSend = vi.mocked(sendChatMessage);
const mockedCreateLink = vi.mocked(createWorkspaceScmLink);

function makeModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    label: overrides.id,
    group: "Claude Code",
    extraUsage: false,
    contextWindowTokens: 200_000,
    ...overrides,
  };
}

const ISSUE_ARGS: SendToNewWorkspaceArgs = {
  repoId: "repo-1",
  kind: "issue",
  number: 893,
  title: "Make OpenRouter balance always-on",
  url: "https://github.com/utensils/claudette/issues/893",
  modelId: "claude-opus-4-7",
};

const PR_ARGS: SendToNewWorkspaceArgs = {
  repoId: "repo-1",
  kind: "pr",
  number: 884,
  title: "implement /compact on the Pi SDK harness",
  url: "https://github.com/utensils/claudette/pull/884",
  branch: "feat/pi-compact",
  modelId: "sonnet",
};

/// Echo a `createWorkspaceScmLink` call back as a persisted row — mirrors
/// what the Rust command returns (DB-assigned `created_at`).
function makeLinkFromArgs(
  callArgs: Parameters<typeof createWorkspaceScmLink>[0],
): WorkspaceScmLink {
  return {
    workspace_id: callArgs.workspaceId,
    repo_id: callArgs.repoId,
    kind: callArgs.kind,
    number: callArgs.number,
    url: callArgs.url,
    title: callArgs.title,
    created_at: "2026-05-20 15:30:00",
  };
}

beforeEach(() => {
  mockedCreate.mockReset();
  mockedApplyModel.mockClear();
  mockedSend.mockClear();
  mockedCreateLink.mockReset();
  mockedCreateLink.mockImplementation((a) =>
    Promise.resolve(makeLinkFromArgs(a)),
  );
  useAppStore.setState({ chatMessages: {}, toasts: [], workspaceScmLinks: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("renderStarterPrompt", () => {
  it("templates an issue prompt with number, title, and source URL", () => {
    const prompt = renderStarterPrompt(ISSUE_ARGS);
    expect(prompt).toContain(
      `issue #${ISSUE_ARGS.number}: ${ISSUE_ARGS.title}`,
    );
    expect(prompt).toContain(`Source: ${ISSUE_ARGS.url}`);
    expect(prompt).not.toContain("Branch:");
  });

  it("templates a PR prompt and includes the branch when present", () => {
    const prompt = renderStarterPrompt(PR_ARGS);
    expect(prompt).toContain(`PR #${PR_ARGS.number}`);
    expect(prompt).toContain("implement /compact on the Pi SDK harness");
    expect(prompt).toContain(
      "Source: https://github.com/utensils/claudette/pull/884",
    );
    expect(prompt).toContain("Branch: feat/pi-compact");
  });

  it("omits the branch line for a PR with no branch", () => {
    const prompt = renderStarterPrompt({ ...PR_ARGS, branch: undefined });
    expect(prompt).not.toContain("Branch:");
  });
});

describe("buildModelSubmenuItems", () => {
  it("returns a disabled placeholder when the registry is empty", () => {
    const items = buildModelSubmenuItems([], vi.fn());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "No models available",
      disabled: true,
    });
  });

  it("hides legacy models", () => {
    const items = buildModelSubmenuItems(
      [
        makeModel({ id: "opus", label: "Opus 4.7" }),
        makeModel({ id: "old", label: "Opus 4.5", legacy: true }),
      ],
      vi.fn(),
    );
    const labels = items
      .filter((i) => i.type === undefined || i.type === "item")
      .map((i) => ("label" in i ? i.label : ""));
    expect(labels).toContain("Opus 4.7");
    expect(labels).not.toContain("Opus 4.5");
  });

  it("emits a header for each top-level group with a separator between", () => {
    const items = buildModelSubmenuItems(
      [
        makeModel({ id: "opus", label: "Opus 4.7", group: "Claude Code" }),
        makeModel({ id: "gpt", label: "GPT-5.5", group: "Codex" }),
      ],
      vi.fn(),
    );
    const headers = items
      .filter((i) => i.type === "header")
      .map((i) => ("label" in i ? i.label : ""));
    expect(headers).toEqual(["Claude Code", "Codex"]);
    expect(items.some((i) => i.type === "separator")).toBe(true);
  });

  it("sections Pi-discovered models by sub-provider, not the flat Pi group", () => {
    const items = buildModelSubmenuItems(
      [
        makeModel({
          id: "anthropic/claude-sonnet",
          label: "Claude Sonnet 4.6",
          group: "Pi",
          providerKind: "pi_sdk",
          subProvider: "Anthropic",
          subProviderKey: "anthropic",
        }),
        makeModel({
          id: "openrouter/minimax",
          label: "MiniMax-M2.7",
          group: "Pi",
          providerKind: "pi_sdk",
          subProvider: "OpenRouter",
          subProviderKey: "openrouter",
        }),
      ],
      vi.fn(),
    );
    const headers = items
      .filter((i) => i.type === "header")
      .map((i) => ("label" in i ? i.label : ""));
    expect(headers).toEqual(["Anthropic", "OpenRouter"]);
  });

  it("wires onPick to the model that was clicked", async () => {
    const onPick = vi.fn();
    const model = makeModel({ id: "opus", label: "Opus 4.7" });
    const items = buildModelSubmenuItems([model], onPick);
    const item = items.find((i) => i.type === undefined || i.type === "item");
    expect(item && "onSelect" in item).toBe(true);
    if (item && "onSelect" in item) await item.onSelect();
    expect(onPick).toHaveBeenCalledWith(model);
  });
});

describe("sendToNewWorkspace", () => {
  it("creates a workspace, applies the model, inserts the prompt, and sends", async () => {
    mockedCreate.mockResolvedValue({
      workspaceId: "ws-1",
      sessionId: "sess-1",
    });

    await sendToNewWorkspace(ISSUE_ARGS);

    expect(mockedCreate).toHaveBeenCalledWith("repo-1", {
      selectOnCreate: true,
      idempotencyKey: [
        "project-send",
        ISSUE_ARGS.repoId,
        ISSUE_ARGS.kind,
        String(ISSUE_ARGS.number),
        ISSUE_ARGS.url,
      ].join(":"),
      onIdempotencyDuplicate: expect.any(Function),
    });
    expect(mockedApplyModel).toHaveBeenCalledWith(
      "sess-1",
      "claude-opus-4-7",
      "anthropic",
    );

    // The user's prompt is optimistically inserted into the chat store so
    // the new workspace doesn't open straight to the agent's first reply.
    const messages = useAppStore.getState().chatMessages["sess-1"] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("User");
    expect(messages[0].content).toContain(`issue #${ISSUE_ARGS.number}`);

    // The optimistic row and the send share one messageId so the
    // backend-persisted echo collapses onto the same key.
    const sendArgs = mockedSend.mock.calls[0];
    expect(sendArgs[0]).toBe("sess-1");
    expect(sendArgs[4]).toBe("claude-opus-4-7"); // model
    expect(sendArgs[11]).toBe("anthropic"); // backendId
    expect(sendArgs[13]).toBe(messages[0].id); // messageId
  });

  it("routes through the model's explicit providerId", async () => {
    mockedCreate.mockResolvedValue({
      workspaceId: "ws-2",
      sessionId: "sess-2",
    });

    await sendToNewWorkspace({
      ...ISSUE_ARGS,
      modelId: "claude-sonnet",
      providerId: "openrouter",
    });

    expect(mockedApplyModel).toHaveBeenCalledWith(
      "sess-2",
      "claude-sonnet",
      "openrouter",
    );
    expect(mockedSend.mock.calls[0][11]).toBe("openrouter");
  });

  it("surfaces a toast and skips the send when the create idempotency guard fires", async () => {
    mockedCreate.mockImplementationOnce((_repoId, options) => {
      options?.onIdempotencyDuplicate?.();
      return Promise.resolve(null);
    });

    await sendToNewWorkspace(ISSUE_ARGS);

    expect(mockedApplyModel).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    const toasts = useAppStore.getState().toasts;
    expect(toasts.some((t) => /already being sent/i.test(t.message))).toBe(
      true,
    );
  });

  it("does not add a duplicate toast when create returns null for another reason", async () => {
    mockedCreate.mockResolvedValue(null);

    await sendToNewWorkspace(ISSUE_ARGS);

    expect(mockedApplyModel).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(
      useAppStore
        .getState()
        .toasts.some((t) => /already being sent/i.test(t.message)),
    ).toBe(false);
  });

  it("toasts a confirmation after a successful send", async () => {
    mockedCreate.mockResolvedValue({
      workspaceId: "ws-3",
      sessionId: "sess-3",
    });

    await sendToNewWorkspace({ ...PR_ARGS });

    const toasts = useAppStore.getState().toasts;
    expect(
      toasts.some((t) => t.message.includes(`Sent #${PR_ARGS.number}`)),
    ).toBe(true);
  });

  it("propagates a create failure to the caller", async () => {
    mockedCreate.mockRejectedValue(new Error("disk full"));
    await expect(sendToNewWorkspace(ISSUE_ARGS)).rejects.toThrow("disk full");
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("persists the issue/PR -> workspace link into the store", async () => {
    mockedCreate.mockResolvedValue({
      workspaceId: "ws-4",
      sessionId: "sess-4",
    });

    await sendToNewWorkspace(ISSUE_ARGS);

    expect(mockedCreateLink).toHaveBeenCalledWith({
      workspaceId: "ws-4",
      repoId: "repo-1",
      kind: "issue",
      number: ISSUE_ARGS.number,
      url: ISSUE_ARGS.url,
      title: ISSUE_ARGS.title,
    });
    const link = useAppStore.getState().workspaceScmLinks["ws-4"];
    expect(link).toMatchObject({
      workspace_id: "ws-4",
      kind: "issue",
      number: ISSUE_ARGS.number,
    });
  });

  it("still completes the send when link persistence fails", async () => {
    mockedCreate.mockResolvedValue({
      workspaceId: "ws-5",
      sessionId: "sess-5",
    });
    mockedCreateLink.mockRejectedValueOnce(new Error("db locked"));

    await sendToNewWorkspace(ISSUE_ARGS);

    // The send is non-negotiable; only the badge is lost.
    expect(mockedSend).toHaveBeenCalled();
    expect(useAppStore.getState().workspaceScmLinks["ws-5"]).toBeUndefined();
  });

  it("records the link before the send so the badge is instant", async () => {
    mockedCreate.mockResolvedValue({
      workspaceId: "ws-6",
      sessionId: "sess-6",
    });
    mockedSend.mockRejectedValueOnce(new Error("network down"));

    // `sendChatMessage` blocks on the new workspace's env prep (direnv
    // / nix, ~20-30s) and can fail outright. The association is keyed
    // on workspace *creation*, so it is recorded before the send — the
    // badge appears immediately, and a later send failure still leaves
    // a valid link (the workspace exists; the user can retry from it).
    await expect(sendToNewWorkspace(ISSUE_ARGS)).rejects.toThrow(
      "network down",
    );
    expect(mockedCreateLink).toHaveBeenCalled();
    expect(useAppStore.getState().workspaceScmLinks["ws-6"]).toMatchObject({
      workspace_id: "ws-6",
      number: ISSUE_ARGS.number,
    });
  });
});
