import {
  clearConversation,
  launchCodexLogin,
  listSlashCommands,
  loadAttachmentsForSession,
  loadCompletedTurns,
  loadDiffFiles,
  openReleaseNotes,
  openUsageSettings,
  readPlanFile,
  recordSlashCommandUsage,
  sendRemoteCommand,
  setAppSetting,
} from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import type { AppState, PermissionLevel } from "../../stores/useAppStore";
import type { Repository } from "../../types/repository";
import type { SlashCommand } from "../../services/tauri";
import type { Workspace } from "../../types/workspace";
import { makeChatMessage } from "../../utils/chatMessage";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { applySelectedModel } from "./applySelectedModel";
import { parseSlashInput, resolveNativeHandler } from "./nativeSlashCommands";
import { findLatestPlanFilePath } from "./planFilePath";
import { setPlanModeAndPersist } from "./planModePersistence";
import { resolveSessionHarness } from "./resolveSessionHarness";

export type NativeSlashOutcome =
  /** Fully handled locally — nothing goes to the agent. */
  | { kind: "handled" }
  /** Send this (possibly rewritten) prompt through the normal agent path. */
  | { kind: "send"; content: string };

const HANDLED: NativeSlashOutcome = { kind: "handled" };

export interface NativeSlashContext {
  sessionId: string;
  workspaceId: string;
  ws: Workspace;
  repo: Repository | null;
  defaultBranch: string | null;
  /** Slash-command list cached for this workspace, if already fetched. */
  cachedSlashCommands: SlashCommand[] | undefined;
  setSlashCommandsCache: AppState["setSlashCommands"];
  usageInsightsEnabled: AppState["usageInsightsEnabled"];
  openPluginSettings: AppState["openPluginSettings"];
  openSettings: AppState["openSettings"];
  appVersion: AppState["appVersion"];
  addChatMessage: AppState["addChatMessage"];
  startClaudeAuthLogin: () => Promise<void>;
}

/**
 * Dispatch a native (built-in) slash command, if `content` is one.
 *
 * Extracted from `ChatPanel.handleSend`. Returns `handled` when the command
 * ran entirely locally, or `send` with the prompt to forward to the agent —
 * the input unchanged for non-commands and shadowed natives, or a rewritten
 * prompt for expansions (and the literal `/compact` for the compact harness
 * action).
 */
export async function dispatchNativeSlash(
  content: string,
  ctx: NativeSlashContext,
): Promise<NativeSlashOutcome> {
  let trimmed = content;
  const {
    sessionId,
    workspaceId: selectedWorkspaceId,
    ws,
    repo,
    defaultBranch,
    setSlashCommandsCache,
    usageInsightsEnabled,
    openPluginSettings,
    openSettings,
    appVersion,
    addChatMessage,
    startClaudeAuthLogin: startChatClaudeAuthLogin,
  } = ctx;
  const slashCommandsByWorkspace: Record<string, SlashCommand[] | undefined> = {
    [selectedWorkspaceId]: ctx.cachedSlashCommands,
  };

  // Native slash command dispatch. Runs before the agent send path so that
  // local_action/settings_route commands never leak to the CLI and
  // prompt_expansion commands can rewrite the prompt before it is sent.
  const parsedSlash = parseSlashInput(trimmed);
  if (parsedSlash) {
    // A user- or project-defined markdown command with the same name takes
    // priority over non-reserved natives (plugin/marketplace remain reserved
    // upstream in the backend registry). Plugin-source commands do NOT get
    // this precedence — only humans editing `.claude/commands/*.md` can
    // override built-ins. Skip native dispatch when such a shadow exists so
    // the custom markdown prompt reaches Claude.
    //
    // The slash-command cache is populated async by ChatInputArea on mount
    // and on workspace change. If a user sends a slash command before that
    // first fetch lands (rare but possible on fast startup), fall back to a
    // synchronous fetch here so shadowing decisions are always made against
    // a fresh list. The Rust side already returns a 5-minute cached result.
    let cmds = slashCommandsByWorkspace[selectedWorkspaceId];
    if (!cmds) {
      try {
        cmds = await listSlashCommands(repo?.path, selectedWorkspaceId);
        setSlashCommandsCache(selectedWorkspaceId, cmds);
      } catch (err) {
        console.error("Failed to load slash commands before native dispatch:", err);
        cmds = [];
      }
    }
    const tokenLower = parsedSlash.token.toLowerCase();
    const candidateHandler = resolveNativeHandler(parsedSlash.token);
    // Only same-name collisions shadow native dispatch. If the typed token
    // is a native alias, also honor a file-based command for the canonical
    // name — the user has replaced the whole native, so the alias should
    // route through the replacement too. If the typed token is the
    // canonical name, do NOT expand to aliases: a user `configure.md`
    // should not hijack `/config` when the canonical slot is still the
    // built-in.
    const shadowNames = new Set<string>([tokenLower]);
    if (candidateHandler) {
      const canonicalLower = candidateHandler.name.toLowerCase();
      const typedIsAlias = candidateHandler.aliases.some(
        (alias) => alias.toLowerCase() === tokenLower,
      );
      if (typedIsAlias) {
        shadowNames.add(canonicalLower);
      }
    }
    const shadowed = cmds.some(
      (c) =>
        (c.source === "user" || c.source === "project") &&
        shadowNames.has(c.name.toLowerCase()),
    );
    const nativeHandler = shadowed ? null : candidateHandler;
    if (nativeHandler) {
      const workspaceId = selectedWorkspaceId;
      const state = useAppStore.getState();
      const currentModel = state.selectedModel[sessionId] ?? "opus";
      const currentModelProvider = state.selectedModelProvider[sessionId] ?? "anthropic";
      const currentPermission: PermissionLevel =
        state.permissionLevel[sessionId] ?? "full";
      const currentPlanMode = state.planMode[sessionId] ?? false;
      const currentFastMode = state.fastMode[sessionId] ?? false;
      const currentThinking = state.thinkingEnabled[sessionId] ?? false;
      const currentChrome = state.chromeEnabled[sessionId] ?? false;
      const currentEffort = state.effortLevel[sessionId] ?? "auto";
      const planFilePath = findLatestPlanFilePath(sessionId);
      const agentStatusLabel =
        typeof ws.agent_status === "string"
          ? ws.agent_status
          : `Error: ${ws.agent_status.Error}`;
      const isRemoteWorkspace = !!ws.remote_connection_id;

      const addLocalMessage = (text: string) => {
        addChatMessage(
          sessionId,
          makeChatMessage({
            workspaceId,
            sessionId,
            role: "System",
            content: text,
          }),
          { persisted: false },
        );
      };

      const setSelectedModelBound = (nextModel: string, providerId?: string) =>
        applySelectedModel(sessionId, nextModel, providerId ?? "anthropic");

      const setPermissionLevelBound = async (level: PermissionLevel) => {
        const previous =
          useAppStore.getState().permissionLevel[sessionId] ?? "full";
        useAppStore.getState().setPermissionLevel(sessionId, level);
        try {
          await setAppSetting(`permission_level:${sessionId}`, level);
        } catch (err) {
          useAppStore.getState().setPermissionLevel(sessionId, previous);
          throw err;
        }
      };

      const setPlanModeBound = (enabled: boolean) => {
        void setPlanModeAndPersist(sessionId, enabled);
      };

      // Route plan-file reads through the remote server for remote
      // workspaces, matching the PlanApprovalCard's "View plan" dispatch.
      // Falls through to the local Tauri command for local workspaces.
      const remoteConnectionId = ws.remote_connection_id;
      const readPlanFileBound = remoteConnectionId
        ? async (path: string) =>
            (await sendRemoteCommand(remoteConnectionId, "read_plan_file", {
              path,
            })) as string
        : readPlanFile;

      const clearConversationBound = async (restoreFiles: boolean) => {
        // The /clear pipeline (clearConversation + follow-up reloads) runs
        // via local Tauri invokes only — RollbackModal has the same
        // boundary. Surface a clear local message on remote workspaces
        // rather than partially executing and leaving the UI in a
        // half-reset state.
        if (isRemoteWorkspace) {
          throw new Error(
            "/clear is not yet supported for remote workspaces",
          );
        }
        const store = useAppStore.getState();
        const messages = await clearConversation(sessionId, restoreFiles);
        store.rollbackConversation(sessionId, workspaceId, "__clear__", messages);
        loadCompletedTurns(sessionId)
          .then((turnData) => {
            const turns = reconstructCompletedTurns(messages, turnData);
            useAppStore.getState().setCompletedTurns(sessionId, turns);
          })
          .catch((err) =>
            console.error("Failed to reload turns after /clear:", err),
          );
        loadAttachmentsForSession(sessionId)
          .then((atts) =>
            useAppStore.getState().setChatAttachments(sessionId, atts),
          )
          .catch((err) =>
            console.error("Failed to reload attachments after /clear:", err),
          );
        useAppStore.getState().clearDiff();
        loadDiffFiles(workspaceId)
          .then((result) =>
            useAppStore
              .getState()
              .setDiffFiles(result.files, result.merge_base),
          )
          .catch((err) =>
            console.error("Failed to refresh diff after /clear:", err),
          );
      };

      const result = await nativeHandler.execute(
        {
          repoId: repo?.remote_connection_id ? null : repo?.id ?? null,
          usageInsightsEnabled,
          openPluginSettings,
          repository: repo ? { name: repo.name, path: repo.path } : null,
          workspace: ws
            ? { branch: ws.branch_name, worktreePath: ws.worktree_path }
            : null,
          repoDefaultBranch: defaultBranch ?? null,
          openSettings,
          appVersion,
          addLocalMessage,
          startClaudeAuthLogin: startChatClaudeAuthLogin,
          startCodexLogin: async () => {
            await launchCodexLogin(selectedWorkspaceId);
          },
          openUsageSettingsExternal: () => {
            void openUsageSettings().catch((err) =>
              console.error("Failed to open usage settings:", err),
            );
          },
          openReleaseNotes: () => {
            void openReleaseNotes().catch((err) =>
              console.error("Failed to open release notes:", err),
            );
          },
          workspaceId,
          agentStatus: agentStatusLabel,
          selectedModel: currentModel,
          selectedModelProvider: currentModelProvider,
          permissionLevel: currentPermission,
          planMode: currentPlanMode,
          fastMode: currentFastMode,
          thinkingEnabled: currentThinking,
          chromeEnabled: currentChrome,
          effortLevel: currentEffort,
          planFilePath,
          setSelectedModel: setSelectedModelBound,
          setPermissionLevel: setPermissionLevelBound,
          setPlanMode: setPlanModeBound,
          clearConversation: clearConversationBound,
          readPlanFile: readPlanFileBound,
          slashCommands: cmds,
        },
        parsedSlash.args,
      );
      if (result.kind !== "skipped") {
        recordSlashCommandUsage(selectedWorkspaceId, result.canonicalName)
          .catch((nextError) => console.error("Failed to record slash command usage:", nextError));
      }
      if (result.kind === "handled") return HANDLED;
      if (result.kind === "expand") {
        // Rewrite the outgoing content to the expanded prompt and fall through
        // to the normal agent send path (queue, optimistic message, stream).
        trimmed = result.prompt.trim();
        if (!trimmed) return HANDLED;
      }
      if (result.kind === "harness_action" && result.action === "compact") {
        // Remote workspaces dispatch via `sendRemoteCommand` and the
        // remote host's `send_chat_message` resolves the harness
        // against its own backends. Gating against local state here
        // would block supported compactions whenever the local app's
        // backends differ from the remote host's (empty local list,
        // local default Pi while remote runs Claude/Codex, etc.).
        if (isRemoteWorkspace) {
          trimmed = "/compact";
        } else {
          // Resolve the active backend's effective harness via the same
          // fallback chain the send pipeline uses
          // (per-session provider → default backend → first available)
          // purely as a readiness guard: if we can't resolve a harness
          // yet (agentBackends hasn't loaded), surface a local error
          // rather than fire `/compact` against an unknown backend.
          // Every supported harness handles the literal `/compact`:
          // Claude's CLI interprets it natively, while `send_chat_message`
          // (Rust side) intercepts the same string for Codex and Pi and
          // swaps `send_turn` for `start_compact` at the last possible
          // step.
          const harness = resolveSessionHarness({
            sessionId,
            selectedModelProvider: state.selectedModelProvider,
            agentBackends: state.agentBackends,
            defaultAgentBackendId: state.defaultAgentBackendId,
          });
          if (harness === null) {
            addLocalMessage(
              "/compact: backend not ready yet — try again in a moment.",
            );
            return HANDLED;
          }
          // Fall through with the literal `/compact`. The send pipeline
          // (frontend dispatchChatMessage + backend send_chat_message)
          // handles session spawn-or-reuse, user-message persistence,
          // and turn setup uniformly.
          trimmed = "/compact";
        }
      }
    }
  }

  return { kind: "send", content: trimmed };
}
