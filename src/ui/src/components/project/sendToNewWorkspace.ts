import { useAppStore } from "../../stores/useAppStore";
import { createWorkspaceOrchestrated } from "../../hooks/useCreateWorkspace";
import { applySelectedModel } from "../chat/applySelectedModel";
import { sendChatMessage } from "../../services/tauri";
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
  /// Optional `<provider>/<model>` form from the Pi sidecar. When present
  /// we use the prefix as the model provider so applySelectedModel routes
  /// the same way the chat ModelSelector would.
  providerQualifiedId?: string;
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
  });
  if (!outcome) {
    // The single-flight guard fired — another create is mid-flight.
    // Surface a toast so the click doesn't appear to silently no-op.
    store.addToast("A workspace is already being created. Try again in a moment.");
    return;
  }
  const { sessionId } = outcome;
  const provider = args.providerQualifiedId?.split("/")[0] ?? "anthropic";
  await applySelectedModel(sessionId, args.modelId, provider);
  const prompt = renderStarterPrompt(args);
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
    /* backendId */ undefined,
    /* attachments */ undefined,
    /* messageId */ undefined,
  );
  store.addToast(`Sent #${args.number} to a new workspace`);
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
