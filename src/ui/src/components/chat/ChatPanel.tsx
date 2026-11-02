import { useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import { WorkspaceEmptyTabs } from "./WorkspaceEmptyTabs";
import { useAppStore } from "../../stores/useAppStore";
import {
  sendRemoteCommand,
  steerQueuedChatMessage,
  stopAgent,
  forkWorkspaceAtCheckpoint,
} from "../../services/tauri";
import { addPersistedUserMessageToStore } from "./chatTurnLifecycle";
import { dispatchChatMessage } from "./chatMessageDispatch";
import { shouldRecordSendFailureInChat } from "./chatSendFailure";
import type { AttachmentInput } from "../../types/chat";
import { dispatchNativeSlash } from "./nativeSlashDispatch";
import { WorkspacePanelHeader } from "../shared/WorkspacePanelHeader";
import { SessionTabs } from "./SessionTabs";
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
  // Stable identity for the memoized transcript (`MessagesWithTurns`); an
  // inline arrow here re-rendered every message on every ChatPanel render.
  const forkTurn = useCallback(
    (checkpointId: string) => void handleFork(checkpointId),
    [handleFork],
  );

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

  // Shared mid-turn steer: inject `content` into the running turn, record
  // the checkpoint + prompt history + optimistic user message on success,
  // and fall back to queueing it on failure so the user's text never
  // vanishes. Both the composer's skip-queue path and "steer this queued
  // message" go through here.
  const steerIntoRunningTurn = async (
    sessionId: string,
    content: string,
    mentionedFiles: string[] | undefined,
    attachments: AttachmentInput[] | undefined,
    logLabel: string,
  ) => {
    const messageId = crypto.randomUUID();
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
      addPersistedUserMessageToStore(
        sessionId,
        ws.id,
        messageId,
        content,
        attachments,
      );
    } catch (e) {
      const errMsg = String(e);
      console.error(`${logLabel} failed:`, errMsg);
      setQueuedMessage(sessionId, content, mentionedFiles, attachments);
      setError(errMsg);
    } finally {
      setQueuedMessageSteering(sessionId, false);
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

    setError(null);
    await steerIntoRunningTurn(
      activeSessionId,
      content,
      mentionedFiles?.size ? [...mentionedFiles] : undefined,
      attachments,
      "steerQueuedChatMessage (skip-queue)",
    );
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
    setError(null);

    if (!isRunning) {
      const filesSet = mentionedFiles?.length ? new Set(mentionedFiles) : undefined;
      removeQueuedMessage(sessionId, queuedMessage.id);
      await handleSend(content, filesSet, attachments);
      return;
    }

    removeQueuedMessage(sessionId, queuedMessage.id);
    await steerIntoRunningTurn(
      sessionId,
      content,
      mentionedFiles,
      attachments,
      "steerQueuedChatMessage",
    );
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

    // Native slash commands (local actions, settings routes, prompt
    // expansions, harness actions) run before the agent send path so they
    // never leak to the CLI; expansions rewrite the outgoing prompt.
    const slash = await dispatchNativeSlash(trimmed, {
      sessionId,
      workspaceId: selectedWorkspaceId,
      ws,
      repo: repo ?? null,
      defaultBranch: defaultBranch ?? null,
      cachedSlashCommands: slashCommandsByWorkspace[selectedWorkspaceId],
      setSlashCommandsCache,
      usageInsightsEnabled,
      openPluginSettings,
      openSettings,
      appVersion,
      addChatMessage,
      startClaudeAuthLogin: startChatClaudeAuthLogin,
    });
    if (slash.kind === "handled") return;
    trimmed = slash.content;

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
      if (!shouldRecordSendFailureInChat(errMsg)) {
        setError(errMsg);
      }
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
          onForkTurn={forkTurn}
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
