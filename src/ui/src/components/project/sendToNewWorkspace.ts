import { useAppStore } from "../../stores/useAppStore";
import { createWorkspaceOrchestrated } from "../../hooks/useCreateWorkspace";
import { applySelectedModel } from "../chat/applySelectedModel";
import { createWorkspaceScmLink, sendChatMessage } from "../../services/tauri";
import {
  markChatTurnStarting,
  rollbackChatTurnStarting,
} from "../chat/chatMessageDispatch";
import type { Model } from "../chat/modelRegistry";
import type { ContextMenuItem } from "../shared/ContextMenu";

export interface SendToNewWorkspaceArgs {
  repoId: string;
  kind: "issue" | "pr";
  number: number;
  title: string;
  url: string;
  /// PR-only — surfaced in the starter prompt so the agent knows which
  /// branch the upstream change lives on. The workspace itself is still
  /// created on the repo's default base (see TODO in
  /// RepoPullRequestsList.tsx).
  branch?: string;
  modelId: string;
  /// Provider/backend id the model belongs to — the registry's
  /// `Model.providerId`. Passed straight through to `applySelectedModel`
  /// and the send so routing matches the chat ModelSelector. Defaults to
  /// `"anthropic"` when absent (curated Claude Code models carry no
  /// provider id).
  providerId?: string;
}

/// Orchestrates the "right-click → Send to new workspace ▶ <model>" flow.
///
/// 1. Create a workspace via the shared `createWorkspaceOrchestrated`
///    helper — same code path Cmd+Shift+N uses, so the new workspace
///    inherits the optimistic placeholder, slug-rename system message,
///    and setup-script prompt.
/// 2. Apply the chosen model to the new session so the toolbar reflects
///    it and `applySelectedModel`'s cross-harness migration runs (though
///    a fresh session has no transcript to migrate — applySelectedModel
///    short-circuits that case).
/// 3. Send a templated starter prompt as the user's first turn, passing
///    the model id explicitly so the very first send uses the requested
///    model regardless of any `app_settings` write-order races.
export async function sendToNewWorkspace(
  args: SendToNewWorkspaceArgs,
): Promise<void> {
  const store = useAppStore.getState();
  const outcome = await createWorkspaceOrchestrated(args.repoId, {
    selectOnCreate: true,
    idempotencyKey: sendIdempotencyKey(args),
    onIdempotencyDuplicate: () => {
      store.addToast(
        `#${args.number} is already being sent to a new workspace.`,
      );
    },
  });
  if (!outcome) {
    // Either the duplicate callback above already surfaced the true
    // same-item repeat, or the orchestrator handled a backend in-flight
    // rejection with its own repo-scoped toast.
    return;
  }
  const { workspaceId, sessionId } = outcome;
  const provider = args.providerId ?? "anthropic";
  await applySelectedModel(sessionId, args.modelId, provider);
  // Persist the issue/PR -> workspace association the moment the
  // workspace exists. The link records "a workspace was created for
  // this item" — true as soon as creation succeeds — so recording it
  // here keeps the project-view "in progress" badge instant. The
  // alternative (after `sendChatMessage`) would delay the badge by the
  // new workspace's env-prep time: direnv / nix can block the first
  // turn for 20-30s, and the dispatch should read as done immediately.
  // Best-effort: a link-write failure only costs the badge, never the
  // send. The FK cascade still drops the row if the workspace is later
  // deleted, so a failed first turn leaves nothing orphaned — the
  // workspace is real and the user can retry the turn from it.
  try {
    const link = await createWorkspaceScmLink({
      workspaceId,
      repoId: args.repoId,
      kind: args.kind,
      number: args.number,
      url: args.url,
      title: args.title,
    });
    useAppStore.getState().setWorkspaceScmLink(link);
  } catch (e) {
    console.error("[sendToNewWorkspace] failed to persist SCM link:", e);
  }
  const prompt = renderStarterPrompt(args);
  const messageId = crypto.randomUUID();
  markChatTurnStarting({
    sessionId,
    workspaceId,
    messageId,
    content: prompt,
  });
  try {
    await sendChatMessage(
      sessionId,
      prompt,
      /* mentionedFiles */ undefined,
      /* permissionLevel */ undefined,
      args.modelId,
      /* fastMode */ undefined,
      /* thinkingEnabled */ undefined,
      /* planMode */ undefined,
      /* effort */ undefined,
      /* chromeEnabled */ undefined,
      /* disable1mContext */ undefined,
      // Route the first turn through the provider we just persisted via
      // `applySelectedModel`. Without this the backend resolves a default
      // (often the global "Anthropic Claude Code" card), so a Pi-routed
      // model id that also exists on multiple backends could fire on the
      // wrong one for turn 1 even though the toolbar shows the right
      // provider. Matches chatMessageDispatch's `selectedProvider` arg.
      provider,
      /* attachments */ undefined,
      messageId,
    );
  } catch (e) {
    rollbackChatTurnStarting(sessionId, workspaceId);
    throw e;
  }
  store.addToast(`Sent #${args.number} to a new workspace`);
}

function sendIdempotencyKey(args: SendToNewWorkspaceArgs): string {
  return [
    "project-send",
    args.repoId,
    args.kind,
    String(args.number),
    args.url,
  ].join(":");
}

export function renderStarterPrompt(args: SendToNewWorkspaceArgs): string {
  if (args.kind === "issue") {
    return [
      `Please investigate and address issue #${args.number}: ${args.title}`,
      "",
      `Source: ${args.url}`,
    ].join("\n");
  }
  const branchLine = args.branch ? `\nBranch: ${args.branch}` : "";
  return [
    `Please review PR #${args.number} and continue or refactor as needed: ${args.title}`,
    "",
    `Source: ${args.url}${branchLine}`,
  ].join("\n");
}

/// Build the ContextMenu items for the "Send to new workspace" submenu
/// from the chat-side model registry. Groups visible models by their
/// `group` field — and for Pi-discovered rows, also by `subProvider` —
/// so a user with dozens of OpenRouter / Anthropic / Qwen / etc. models
/// surfaced through the Pi sidecar can tell which provider each entry
/// belongs to. Each section gets a `type: "header"` row above its
/// entries. Hides `legacy` rows (the chat ModelSelector tucks those
/// behind a "More…" disclosure — replicating that here would need a
/// third menu layer). Returns a single disabled placeholder when the
/// registry is empty so the gesture is never silently swallowed.
export function buildModelSubmenuItems(
  registry: readonly Model[],
  onPick: (model: Model) => void | Promise<void>,
): ContextMenuItem[] {
  const visible = registry.filter((m) => !m.legacy);
  if (visible.length === 0) {
    return [
      {
        label: "No models available",
        onSelect: () => {},
        disabled: true,
      },
    ];
  }
  const items: ContextMenuItem[] = [];
  let prevSectionKey: string | null = null;
  for (const model of visible) {
    const { sectionKey, sectionLabel } = sectionFor(model);
    if (sectionKey !== prevSectionKey) {
      if (prevSectionKey !== null) {
        items.push({ type: "separator" });
      }
      items.push({ type: "header", label: sectionLabel });
      prevSectionKey = sectionKey;
    }
    items.push({
      label: model.label,
      onSelect: () => onPick(model),
    });
  }
  return items;
}

/// Compute the section a model belongs to in the submenu. Non-Pi rows
/// section by their top-level `group` (e.g. "Claude Code", "Codex").
/// Pi-discovered rows section by `subProvider` so the OpenRouter,
/// Anthropic, Ollama, etc. sub-catalogs each get their own labeled
/// block instead of being flattened into one giant "Pi" wall.
function sectionFor(model: Model): { sectionKey: string; sectionLabel: string } {
  const isPi = model.providerKind === "pi_sdk";
  if (isPi && model.subProvider) {
    return {
      sectionKey: `pi:${model.subProviderKey ?? model.subProvider.toLowerCase()}`,
      sectionLabel: model.subProvider,
    };
  }
  return { sectionKey: `group:${model.group}`, sectionLabel: model.group };
}
