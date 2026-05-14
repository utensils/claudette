import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import { WorkspaceEmptyTabs } from "./WorkspaceEmptyTabs";
import { useAppStore } from "../../stores/useAppStore";
import {
  loadAttachmentsForSession,
  listSlashCommands,
  loadCompletedTurns,
  openReleaseNotes,
  openUsageSettings,
  recordSlashCommandUsage,
  sendRemoteCommand,
  steerQueuedChatMessage,
  stopAgent,
  setAppSetting,
  clearConversation,
  readPlanFile,
  loadDiffFiles,
  forkWorkspaceAtCheckpoint,
  launchCodexLogin,
} from "../../services/tauri";
import { resolveSessionHarness } from "./resolveSessionHarness";
import { applySelectedModel } from "./applySelectedModel";
import { findLatestPlanFilePath } from "./planFilePath";
import type { PermissionLevel } from "../../stores/useAppStore";
import { dispatchChatMessage } from "./chatMessageDispatch";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import type { AttachmentInput } from "../../types/chat";
import {
  parseSlashInput,
  resolveNativeHandler,
} from "./nativeSlashCommands";
import { WorkspacePanelHeader } from "../shared/WorkspacePanelHeader";
import { SessionTabs } from "./SessionTabs";
import { useWorkspaceElapsedSeconds } from "../../hooks/useWorkspaceElapsedSeconds";
import styles from "./ChatPanel.module.css";
import { useChatPanelStore } from "./useChatPanelStore";
import { useChatPanelAttachments } from "./useChatPanelAttachments";
import { useChatPanelSessionLifecycle } from "./useChatPanelSessionLifecycle";
import { ChatPanelAttachmentOverlays } from "./ChatPanelAttachmentOverlays";
import { ChatPanelSessionView } from "./ChatPanelSessionView";

export function ChatPanel() {
  const { t } = useTranslation("chat");
  const {
    activeChatSessionRecord,
    activeSessionId,
    activeSessionIdsKey,
    activitiesCount,
    addChatMessage,
    addCheckpoint,
    appVersion,
    beginPendingFork,
    browseAvailable,
    cancelPendingFork,
    chatAuthLoginRequestId,
    chatAuthLoginStartedRequestId,
    clearAgentApproval,
    clearAgentQuestion,
    clearPlanApproval,
    clearQueuedMessage,
    commitPendingFork,
    completedTurnsCount,
    defaultBranch,
    enqueueTerminalCommand,
    globalOffset,
    hasMore,
    hasPendingTypewriter,
    hasStreaming,
    hasThinking,
    hydrateCompletedTurns,
    isLoadingMore,
    isRunning,
    isSteeringQueued,
    messages,
    noOpenTabs,
    oldestMessageId,
    openChatAuthLoginPanel,
    openPluginSettings,
    openSettings,
    pendingApproval,
    pendingCreateRepoName,
    pendingCreateWorkspaceName,
    pendingForkSourceName,
    pendingPlan,
    pendingQuestion,
    pendingSteerContent,
    queuedMessages,
    removeQueuedMessage,
    repo,
    runningSetupScriptSource,
    searchQuery,
    selectedWorkspaceId,
    sessionsLoaded,
    setChatAuthLoginStartedRequestId,
    setChatMessages,
    setChatPagination,
    setPermissionLevel,
    setPlanMode,
    setQueuedMessage,
    setQueuedMessageAutoDispatchPaused,
    setQueuedMessageEditing,
    setQueuedMessageSteering,
    setSlashCommandsCache,
    showChatAuthLoginPanel,
    showThinkingBlocks,
    slashCommandsByWorkspace,
    steerQueuedTooltip,
    toolDisplayMode,
    updateQueuedMessage,
    usageInsightsEnabled,
    workspaceEnvironmentError,
    workspaceEnvironmentPreparing,
    ws,
  } = useChatPanelStore();
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef<HTMLDivElement>(null);
  const restoringChatScrollSessionsRef = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);

  const {
    attachmentMenu,
    ensureAttachmentBytes,
    lightbox,
    openAttachmentMenu,
    openLightbox,
    setAttachmentMenu,
    setLightbox,
    shareSupported,
  } = useChatPanelAttachments();

  // Prompt history: stores past user inputs per session.
  const historyRef = useRef<Record<string, string[]>>({});
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  const clearQueuedMessagesAndCancelEdit = (sessionId: string) => {
    clearQueuedMessage(sessionId);
    setQueuedMessageEditing(sessionId, false);
  };

  const isRemote = !!ws?.remote_connection_id;

  const handleFork = useCallback(
    async (checkpointId: string) => {
      if (!selectedWorkspaceId || isRemote || !ws) return;

      // Optimistically insert a placeholder workspace and navigate to
      // it BEFORE awaiting the backend. The fork command does a
      // worktree creation + snapshot restore + history copy + Claude
      // session JSONL copy, which can take a few seconds on big
      // sessions; without this the user clicks Fork and sees nothing
      // happen until the backend round-trip completes.  The
      // placeholder mirrors the source workspace's repo/branch shape
      // closely enough that the sidebar renders a believable row
      // (under the same repo, with the source name suffixed
      // "-fork…").  It carries a temporary id so the chat panel can
      // detect it via `pendingForks` and render a "Preparing fork
      // from <source>…" affordance instead of the empty-workspace
      // tabs.  `commitPendingFork` swaps it for the real workspace
      // once the backend resolves and `cancelPendingFork` tears it
      // down on error.
      const placeholderId = `pending-fork-${crypto.randomUUID()}`;
      const placeholder = {
        id: placeholderId,
        repository_id: ws.repository_id,
        // Mirror the backend allocator's `<source>-fork` suffix so the
        // user sees roughly the same name in the sidebar before and
        // after the swap. The backend may bump to `-fork-2` if there's
        // a collision; the post-swap row reflects the final name.
        name: `${ws.name}-fork`,
        branch_name: `${ws.branch_name}-fork`,
        worktree_path: null,
        status: "Active" as const,
        agent_status: "Idle" as const,
        status_line: "",
        created_at: new Date().toISOString(),
        sort_order: ws.sort_order + 1,
        // Fork inherits its source workspace's input_values once the
        // backend completes the create — this placeholder is swapped out
        // by `commitPendingFork` before any env merge reads it.
        input_values: null,
        remote_connection_id: null,
      };
      const previousSelection = selectedWorkspaceId;
      beginPendingFork(placeholder, selectedWorkspaceId);

      try {
        const result = await forkWorkspaceAtCheckpoint(
          previousSelection,
          checkpointId,
        );
        // Stamp the UI-only `remote_connection_id: null` field — the
        // Rust `Workspace` model doesn't serialize it, so the IPC
        // payload arrives with the field missing entirely.  Without
        // the stamp, `useWorkspaceEnvironmentPreparation` treats the
        // row as unhydrated and bails out of
        // `prepare_workspace_environment`, leaving the just-forked
        // workspace stranded at `"preparing"`.  Defense-in-depth
        // against IPC-event timing — the backend's
        // `workspaces-changed` emit will also stamp it, but doing it
        // here makes the swap deterministic regardless of which lands
        // first.
        commitPendingFork(placeholderId, {
          ...result.workspace,
          remote_connection_id: null,
        });
      } catch (err) {
        cancelPendingFork(placeholderId, previousSelection);
        setError(`Failed to fork workspace: ${err}`);
      }
    },
    [
      selectedWorkspaceId,
      isRemote,
      ws,
      beginPendingFork,
      commitPendingFork,
      cancelPendingFork,
    ],
  );

  const elapsed = useWorkspaceElapsedSeconds(selectedWorkspaceId, isRunning);

  const {
    isAtBottom,
    markUserScrollIntent,
    rememberChatScrollPosition,
    scrollContextValue,
    scrollToBottom,
  } = useChatPanelSessionLifecycle({
    activeSessionId,
    activeSessionIdsKey,
    activitiesCount,
    completedTurnsCount,
    draftRef,
    hasMore,
    hasStreaming,
    historyIndexRef,
    historyRef,
    hydrateCompletedTurns,
    isLoadingMore,
    isRunning,
    messages,
    messagesContainerRef,
    oldestMessageId,
    pendingApproval,
    pendingPlan,
    pendingQuestion,
    restoringChatScrollSessionsRef,
    selectedWorkspaceId,
    setChatMessages,
    setChatPagination,
    setError,
    setPermissionLevel,
  });
  const startChatClaudeAuthLogin = useCallback(async () => {
    openChatAuthLoginPanel();
  }, [openChatAuthLoginPanel]);

  if (!ws) return null;

  const addPersistedUserMessageToStore = (
    sessionId: string,
    messageId: string,
    content: string,
    attachments?: AttachmentInput[],
  ) => {
    addChatMessage(sessionId, {
      id: messageId,
      workspace_id: ws.id,
      chat_session_id: sessionId,
      role: "User",
      content,
      cost_usd: null,
      duration_ms: null,
      created_at: new Date().toISOString(),
      thinking: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    });
    if (attachments?.length) {
      const optimisticAtts = attachments.map((a) => ({
        id: crypto.randomUUID(),
        message_id: messageId,
        filename: a.filename,
        media_type: a.media_type,
        data_base64: a.data_base64,
        text_content: a.text_content ?? null,
        width: null,
        height: null,
        size_bytes: Math.ceil(a.data_base64.length * 0.75),
      }));
      useAppStore.getState().addChatAttachments(sessionId, optimisticAtts);
    }
  };

  // Skip-queue / steer entry from the chat composer (default Cmd+Enter).
  // Mirrors handleSteerQueuedMessage but takes content from the input area
  // directly instead of the queued-message slot — the user is asking to
  // inject the freshly-typed message mid-turn instead of letting it sit
  // in the queue until the current turn finishes.
  const handleSendSteer = async (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => {
    const trimmed = content.trim();
    if ((!trimmed && !attachments?.length) || !activeSessionId) return;
    if (ws?.remote_connection_id) {
      // Mid-turn steering isn't supported over the remote transport yet,
      // but the typed message must NOT be lost — fall back to the normal
      // send path so it lands in the queue (which IS supported remotely).
      // ChatInputArea also catches this earlier; this is defense in depth
      // for any future caller that bypasses the composer (Copilot review).
      await handleSend(content, mentionedFiles, attachments);
      return;
    }
    if (!isRunning) {
      // Defensive — ChatInputArea also falls back to handleSend when not
      // running, but the user could conceivably trigger this from another
      // entry point in the future. Route through the normal send path.
      await handleSend(content, mentionedFiles, attachments);
      return;
    }
    if (isSteeringQueued) return;

    const sessionId = activeSessionId;
    const messageId = crypto.randomUUID();
    const mentionedFilesArray = mentionedFiles?.size
      ? [...mentionedFiles]
      : undefined;
    setError(null);
    setQueuedMessageSteering(sessionId, true, content);
    try {
      const checkpoint = await steerQueuedChatMessage(
        sessionId,
        content,
        mentionedFilesArray,
        attachments,
        messageId,
      );
      if (checkpoint) {
        addCheckpoint(sessionId, checkpoint);
      }
      const history = (historyRef.current[sessionId] ??= []);
      history.push(content);
      historyIndexRef.current = -1;
      draftRef.current = "";
      addPersistedUserMessageToStore(sessionId, messageId, content, attachments);
    } catch (e) {
      const errMsg = String(e);
      console.error("steerQueuedChatMessage (skip-queue) failed:", errMsg);
      // Steer failed mid-turn — fall back to queueing so the user's typed
      // message doesn't vanish. They can re-trigger it manually.
      setQueuedMessage(sessionId, content, mentionedFilesArray, attachments);
      setError(errMsg);
    } finally {
      setQueuedMessageSteering(sessionId, false);
    }
  };

  const handleSteerQueuedMessage = async (queuedMessageId: string) => {
    if (!activeSessionId || isSteeringQueued) return;
    const queuedMessage = queuedMessages.find((message) => message.id === queuedMessageId);
    if (!queuedMessage) return;
    if (ws?.remote_connection_id) {
      setError("Mid-turn steering is not yet supported for remote workspaces");
      return;
    }

    const sessionId = activeSessionId;
    const { content, mentionedFiles, attachments } = queuedMessage;
    const messageId = crypto.randomUUID();
    setError(null);

    if (!isRunning) {
      const filesSet = mentionedFiles?.length ? new Set(mentionedFiles) : undefined;
      removeQueuedMessage(sessionId, queuedMessage.id);
      await handleSend(content, filesSet, attachments);
      return;
    }

    removeQueuedMessage(sessionId, queuedMessage.id);
    setQueuedMessageSteering(sessionId, true, content);
    try {
      const checkpoint = await steerQueuedChatMessage(
        sessionId,
        content,
        mentionedFiles,
        attachments,
        messageId,
      );
      if (checkpoint) {
        addCheckpoint(sessionId, checkpoint);
      }
      const history = (historyRef.current[sessionId] ??= []);
      history.push(content);
      historyIndexRef.current = -1;
      draftRef.current = "";
      addPersistedUserMessageToStore(sessionId, messageId, content, attachments);
    } catch (e) {
      const errMsg = String(e);
      console.error("steerQueuedChatMessage failed:", errMsg);
      setQueuedMessage(sessionId, content, mentionedFiles, attachments);
      setError(errMsg);
    } finally {
      setQueuedMessageSteering(sessionId, false);
    }
  };

  const handleSteerQueuedTop = () => {
    const firstQueuedMessage = queuedMessages[0];
    if (!firstQueuedMessage) return;
    void handleSteerQueuedMessage(firstQueuedMessage.id);
  };

  const handleRunShellCommand = async (command: string) => {
    if (!selectedWorkspaceId) return;
    if (ws?.remote_connection_id) {
      setError("Shell commands are not yet supported for remote workspaces");
      return;
    }
    setError(null);
    enqueueTerminalCommand(selectedWorkspaceId, command);
  };

  const handleRetryWorkspaceEnvironment = () => {
    if (!selectedWorkspaceId || ws?.remote_connection_id) return;
    setError(null);
    useAppStore.getState().retryWorkspaceEnvironment(selectedWorkspaceId);
  };

  const handleSend = async (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => {
    let trimmed = content.trim();
    if (
      (!trimmed && !attachments?.length) ||
      !selectedWorkspaceId ||
      !activeSessionId
    )
      return;
    const sessionId = activeSessionId;

    // Convert mentioned files set to array for the backend.
    const mentionedFilesArray = mentionedFiles?.size
      ? [...mentionedFiles]
      : undefined;

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
            {
              id: crypto.randomUUID(),
              workspace_id: workspaceId,
              chat_session_id: sessionId,
              role: "System",
              content: text,
              cost_usd: null,
              duration_ms: null,
              created_at: new Date().toISOString(),
              thinking: null,
              input_tokens: null,
              output_tokens: null,
              cache_read_tokens: null,
              cache_creation_tokens: null,
            },
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
          useAppStore.getState().setPlanMode(sessionId, enabled);
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
            startCodexLogin: launchCodexLogin,
            startPiLogin: async () => {
              useAppStore.getState().openModal("piLogin", {
                workingDir: ws?.worktree_path ?? "",
              });
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
        if (result.kind === "handled") return;
        if (result.kind === "expand") {
          // Rewrite the outgoing content to the expanded prompt and fall through
          // to the normal agent send path (queue, optimistic message, stream).
          trimmed = result.prompt.trim();
          if (!trimmed) return;
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
              return;
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

    // If the agent is running, queue the message instead of interrupting.
    // The user can press Escape to stop the agent if they want to interrupt.
    // Queued messages are auto-sent when the current turn finishes.
    if (isRunning) {
      setQueuedMessage(
        sessionId,
        trimmed,
        mentionedFilesArray,
        attachments,
      );
      return;
    }

    setError(null);

    // Push to prompt history.
    const history = (historyRef.current[sessionId] ??= []);
    history.push(trimmed);
    historyIndexRef.current = -1;
    draftRef.current = "";

    try {
      await dispatchChatMessage({
        sessionId,
        content: trimmed,
        mentionedFiles: mentionedFilesArray,
        attachments,
      });
    } catch (e) {
      const errMsg = String(e);
      console.error("dispatchChatMessage failed:", errMsg);
      setError(errMsg);
    }
  };

  const handleStop = async () => {
    if (!activeSessionId || !selectedWorkspaceId) return;
    const sessionId = activeSessionId;
    // A manual stop means the user wants control of the next turn. Keep the
    // queue visible, but stop the idle auto-drain from consuming it.
    if (queuedMessages.length > 0) {
      setQueuedMessageAutoDispatchPaused(sessionId, true);
      setQueuedMessageEditing(sessionId, false);
    }
    try {
      if (ws?.remote_connection_id) {
        await sendRemoteCommand(ws.remote_connection_id, "stop_agent", {
          chat_session_id: sessionId,
        });
      } else {
        await stopAgent(sessionId);
      }
      // Don't write workspace-level agent_status here: stop is per-session
      // and other sessions in the workspace may still be running. The
      // backend ProcessExited event flips this session to Stopped, and
      // useAgentStream re-derives the workspace aggregate from sessions.
    } catch (e) {
      console.error("stopAgent failed:", e);
    }
  };

  return (
    <div className={styles.panel}>
      <WorkspacePanelHeader />
      {/* Skip the session tab strip for the optimistic-fork placeholder.
          The backend has no row for the placeholder id yet, so SessionTabs'
          mount-time `listChatSessions(workspaceId)` would error with
          "Workspace not found" and the tab strip would render empty
          anyway. Suppressing it keeps the placard centered cleanly and
          stops the console-error spam during the fork window. */}
      {selectedWorkspaceId &&
        !pendingForkSourceName &&
        !pendingCreateWorkspaceName && (
          <SessionTabs workspaceId={selectedWorkspaceId} />
        )}

      {pendingCreateWorkspaceName ? (
        // Optimistic-create placeholder: the user clicked New
        // Workspace, we generated a slug, inserted a placeholder
        // row into the store, selected it, and are now awaiting
        // `createWorkspace` to return. Same shape as the fork
        // placard below — render a static placard with the env
        // console mounted against the placeholder id so any output
        // buffered against it (host.console heartbeats from
        // env-dotenv, etc.) is visible during the create window.
        // After commit, the placard disappears and the regular chat
        // panel takes over for the real workspace.
        <div className={styles.preparingFork} role="status" aria-live="polite">
          <LoaderCircle size={20} className={styles.preparingForkSpinner} />
          <div className={styles.preparingForkText}>
            {t("preparing_workspace_in", "Preparing workspace in {{repo}}…", {
              repo: pendingCreateRepoName ?? "this repository",
            })}
            <div className={styles.preparingForkSub}>
              {pendingCreateWorkspaceName}
            </div>
          </div>
        </div>
      ) : pendingForkSourceName ? (
        // Optimistic-fork placeholder: the user clicked Fork from a
        // checkpoint, we inserted a placeholder workspace into the
        // store, selected it, and are now awaiting
        // `fork_workspace_at_checkpoint` to return.  Render a static
        // "Preparing fork from <source>…" affordance instead of the
        // normal session/empty-tab UI so the user lands on a clear
        // "we're working on it" state the instant they click,
        // regardless of how slow the snapshot-restore + history-copy
        // is on the source workspace. The placeholder swaps to the
        // real fork via `commitPendingFork` once the backend resolves.
        <div className={styles.preparingFork} role="status" aria-live="polite">
          <LoaderCircle size={20} className={styles.preparingForkSpinner} />
          <div className={styles.preparingForkText}>
            {t("preparing_fork_from", "Preparing fork from {{name}}…", {
              name: pendingForkSourceName,
            })}
          </div>
        </div>
      ) : selectedWorkspaceId && !sessionsLoaded ? (
        // Loading window: sessions for this workspace haven't landed yet
        // (see the `sessionsLoaded` comment above). Hold the layout open
        // with a blank shell so neither `WorkspaceEmptyTabs` nor the
        // "Send a message…" placard flashes during the transition. The
        // header and tab strip above keep painting so the chrome stays
        // anchored.
        <div className={styles.loadingShell} aria-hidden="true" />
      ) : noOpenTabs ? (
        // All chat sessions, diff tabs, and file tabs are closed. Skip the
        // chat content + composer entirely so the user lands on a clear
        // affordance for opening a new session instead of a blank pane.
        // The tab strip's `+` button stays above for the mouse path.
        <WorkspaceEmptyTabs workspace={ws} repository={repo} />
      ) : (
        <ChatPanelSessionView
          activeChatSessionRecord={activeChatSessionRecord}
          activeSessionId={activeSessionId}
          activitiesCount={activitiesCount}
          chatAuthLoginRequestId={chatAuthLoginRequestId}
          chatAuthLoginStartedRequestId={chatAuthLoginStartedRequestId}
          clearAgentApproval={clearAgentApproval}
          clearAgentQuestion={clearAgentQuestion}
          clearPlanApproval={clearPlanApproval}
          clearQueuedMessagesAndCancelEdit={clearQueuedMessagesAndCancelEdit}
          draftRef={draftRef}
          elapsed={elapsed}
          error={error}
          globalOffset={globalOffset}
          hasPendingTypewriter={hasPendingTypewriter}
          hasStreaming={hasStreaming}
          hasThinking={hasThinking}
          historyIndexRef={historyIndexRef}
          historyRef={historyRef}
          isAtBottom={isAtBottom}
          isLoadingMore={isLoadingMore}
          isRemote={isRemote}
          isRunning={isRunning}
          isSteeringQueued={isSteeringQueued}
          markUserScrollIntent={markUserScrollIntent}
          messages={messages}
          messagesContainerRef={messagesContainerRef}
          onAttachmentClick={openLightbox}
          onAttachmentContextMenu={openAttachmentMenu}
          onForkTurn={(checkpointId) => void handleFork(checkpointId)}
          onRetryWorkspaceEnvironment={handleRetryWorkspaceEnvironment}
          onRunShellCommand={handleRunShellCommand}
          onSend={handleSend}
          onSendSteer={handleSendSteer}
          onSteerQueuedMessage={handleSteerQueuedMessage}
          onSteerQueuedTop={handleSteerQueuedTop}
          onStop={handleStop}
          pendingApproval={pendingApproval}
          pendingPlan={pendingPlan}
          pendingQuestion={pendingQuestion}
          pendingSteerContent={pendingSteerContent}
          processingRef={processingRef}
          queuedMessages={queuedMessages}
          rememberChatScrollPosition={rememberChatScrollPosition}
          removeQueuedMessage={removeQueuedMessage}
          repo={repo}
          runningSetupScriptSource={runningSetupScriptSource}
          scrollContextValue={scrollContextValue}
          scrollToBottom={scrollToBottom}
          searchQuery={searchQuery}
          selectedWorkspaceId={selectedWorkspaceId}
          setChatAuthLoginStartedRequestId={setChatAuthLoginStartedRequestId}
          setError={setError}
          setPlanMode={setPlanMode}
          setQueuedMessageEditing={setQueuedMessageEditing}
          showChatAuthLoginPanel={showChatAuthLoginPanel}
          showThinkingBlocks={showThinkingBlocks}
          steerQueuedTooltip={steerQueuedTooltip}
          toolDisplayMode={toolDisplayMode}
          updateQueuedMessage={updateQueuedMessage}
          workspaceEnvironmentError={workspaceEnvironmentError}
          workspaceEnvironmentPreparing={workspaceEnvironmentPreparing}
          ws={ws}
        />
      )}
      <ChatPanelAttachmentOverlays
        attachmentMenu={attachmentMenu}
        browseAvailable={browseAvailable}
        ensureAttachmentBytes={ensureAttachmentBytes}
        lightbox={lightbox}
        openAttachmentMenu={openAttachmentMenu}
        setAttachmentMenu={setAttachmentMenu}
        setLightbox={setLightbox}
        shareSupported={shareSupported}
      />
    </div>
  );
}
