import { useMemo } from "react";
import type {
  ContextType,
  Dispatch,
  MouseEvent,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, SendHorizontal } from "lucide-react";

import type { AttachmentInput } from "../../types/chat";
import type { DownloadableAttachment } from "../../utils/attachmentDownload";
import { ChatAuthFailureCallout } from "../auth/ChatAuthFailureCallout";
import { ChatEmptyState } from "./ChatEmptyState";
import { ChatErrorBanner } from "./ChatErrorBanner";
import { ChatInputArea } from "./ChatInputArea";
import { ChatSearchBar } from "./ChatSearchBar";
import { CliInvocationBanner } from "./CliInvocationBanner";
import { CurrentTurnTaskProgress } from "./CurrentTurnTaskProgress";
import { MessagesWithTurns } from "./MessagesWithTurns";
import { OverlayScrollbar } from "./OverlayScrollbar";
import { QueuedMessagesPopover } from "./QueuedMessagesPopover";
import { ScrollContext } from "./ScrollContext";
import { ScrollToBottomPill } from "./ScrollToBottomPill";
import { WorkflowStatusPill } from "./WorkflowStatusPill";
import { SetupScriptBanner } from "./SetupScriptBanner";
import { StreamingMessage } from "./StreamingMessage";
import { StreamingThinkingBlock } from "./StreamingThinkingBlock";
import { PendingControlCards } from "./PendingControlCards";
import { ProcessingIndicator } from "./ProcessingIndicator";
import { extractMentionPaths } from "./queuedMessageEditing";
import { usePendingChatPrompt } from "./usePendingChatPrompt";
import styles from "./ChatPanel.module.css";
import type { useChatPanelStore } from "./useChatPanelStore";

type ChatPanelStore = ReturnType<typeof useChatPanelStore>;

type ChatPanelSessionViewProps = Pick<
  ChatPanelStore,
  | "activeChatSessionRecord"
  | "activeSessionId"
  | "activitiesCount"
  | "chatAuthLoginRequestId"
  | "chatAuthLoginStartedRequestId"
  | "clearAgentApproval"
  | "clearAgentQuestion"
  | "clearPlanApproval"
  | "globalOffset"
  | "hasPendingTypewriter"
  | "hasStreaming"
  | "hasThinking"
  | "isLoadingMore"
  | "isRunning"
  | "isSteeringQueued"
  | "messages"
  | "pendingApproval"
  | "pendingPlan"
  | "pendingQuestion"
  | "pendingSteerContent"
  | "queuedMessages"
  | "removeQueuedMessage"
  | "repo"
  | "runningSetupScriptSource"
  | "searchQuery"
  | "selectedWorkspaceId"
  | "setChatAuthLoginStartedRequestId"
  | "setQueuedMessageEditing"
  | "showChatAuthLoginPanel"
  | "showThinkingBlocks"
  | "steerQueuedTooltip"
  | "toolDisplayMode"
  | "updateQueuedMessage"
  | "workspaceEnvironmentError"
  | "workspaceEnvironmentPreparing"
  | "ws"
> & {
  clearQueuedMessagesAndCancelEdit: (sessionId: string) => void;
  draftRef: MutableRefObject<string>;
  error: string | null;
  historyIndexRef: MutableRefObject<number>;
  historyRef: MutableRefObject<Record<string, string[]>>;
  isAtBottom: boolean;
  isRemote: boolean;
  markUserScrollIntent: () => void;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  onAttachmentContextMenu: (
    e: MouseEvent,
    attachment: DownloadableAttachment,
    attachmentId?: string,
  ) => void;
  onAttachmentClick: (e: MouseEvent, attachment: DownloadableAttachment) => void;
  onForkTurn: (checkpointId: string) => void;
  onRetryWorkspaceEnvironment: () => void;
  onRunShellCommand: (command: string) => void | Promise<void>;
  onSend: (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => Promise<void>;
  onSendSteer: (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => Promise<void>;
  onSteerQueuedMessage: (queuedMessageId: string) => void | Promise<void>;
  onSteerQueuedTop: () => void;
  onStop: () => void | Promise<void>;
  processingRef: RefObject<HTMLDivElement | null>;
  rememberChatScrollPosition: () => void;
  scrollContextValue: ContextType<typeof ScrollContext>;
  scrollToBottom: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function ChatPanelSessionView({
  activeChatSessionRecord,
  activeSessionId,
  activitiesCount,
  chatAuthLoginRequestId,
  chatAuthLoginStartedRequestId,
  clearAgentApproval,
  clearAgentQuestion,
  clearPlanApproval,
  clearQueuedMessagesAndCancelEdit,
  draftRef,
  error,
  globalOffset,
  hasPendingTypewriter,
  hasStreaming,
  hasThinking,
  historyIndexRef,
  historyRef,
  isAtBottom,
  isLoadingMore,
  isRemote,
  isRunning,
  isSteeringQueued,
  markUserScrollIntent,
  messages,
  messagesContainerRef,
  onAttachmentClick,
  onAttachmentContextMenu,
  onForkTurn,
  onRetryWorkspaceEnvironment,
  onRunShellCommand,
  onSend,
  onSendSteer,
  onSteerQueuedMessage,
  onSteerQueuedTop,
  onStop,
  pendingApproval,
  pendingPlan,
  pendingQuestion,
  pendingSteerContent,
  processingRef,
  queuedMessages,
  rememberChatScrollPosition,
  removeQueuedMessage,
  repo,
  runningSetupScriptSource,
  scrollContextValue,
  scrollToBottom,
  searchQuery,
  selectedWorkspaceId,
  setChatAuthLoginStartedRequestId,
  setError,
  setQueuedMessageEditing,
  showChatAuthLoginPanel,
  showThinkingBlocks,
  steerQueuedTooltip,
  toolDisplayMode,
  updateQueuedMessage,
  workspaceEnvironmentError,
  workspaceEnvironmentPreparing,
  ws,
}: ChatPanelSessionViewProps) {
  const { t } = useTranslation("chat");
  const cliInvocation = activeChatSessionRecord?.cli_invocation ?? null;

  // Built once per relevant input change rather than inline in JSX:
  // `MessagesWithTurns` is memoized, and fresh element props on every
  // render of this view defeated that memo — the whole transcript
  // re-rendered on any parent update.
  const hasLiveActivities = activitiesCount > 0;
  const liveTaskProgressNode = useMemo(
    () =>
      activeSessionId && hasLiveActivities ? (
        <CurrentTurnTaskProgress sessionId={activeSessionId} />
      ) : null,
    [activeSessionId, hasLiveActivities],
  );
  const streamingThinkingNode = useMemo(
    () =>
      activeSessionId && hasThinking && showThinkingBlocks ? (
        <StreamingThinkingBlock
          sessionId={activeSessionId}
          isStreaming={isRunning ?? false}
          inline={toolDisplayMode === "inline"}
          searchQuery={searchQuery}
        />
      ) : null,
    [
      activeSessionId,
      hasThinking,
      isRunning,
      searchQuery,
      showThinkingBlocks,
      toolDisplayMode,
    ],
  );
  const streamingMessageNode = useMemo(
    () =>
      activeSessionId && selectedWorkspaceId && (hasStreaming || hasPendingTypewriter) ? (
        <StreamingMessage
          sessionId={activeSessionId}
          workspaceId={selectedWorkspaceId}
          isStreaming={isRunning ?? false}
          searchQuery={searchQuery}
        />
      ) : null,
    [
      activeSessionId,
      hasPendingTypewriter,
      hasStreaming,
      isRunning,
      searchQuery,
      selectedWorkspaceId,
    ],
  );

  // Prompts handed off by a pinned prompt that opened its own tab. The
  // launcher can't call `onSend` directly — that closure is bound to
  // whichever session is active — so it queues the prompt and we dispatch
  // once the target tab becomes the active one. Mentions are re-extracted
  // from the text because a queued prompt was never typed through the file
  // picker. This lives here rather than in ChatPanel because ChatPanel
  // returns early when it has no workspace, which would make the hook call
  // conditional.
  usePendingChatPrompt(activeSessionId, (content) => {
    const mentioned = extractMentionPaths(content);
    return onSend(content, mentioned.size > 0 ? mentioned : undefined);
  });

  return (
    <>
      <div className={styles.messagesWrapper}>
        {selectedWorkspaceId && (
          <ChatSearchBar
            workspaceId={selectedWorkspaceId}
            scopeRef={messagesContainerRef}
          />
        )}
        <ScrollContext.Provider value={scrollContextValue}>
          <OverlayScrollbar
            targetRef={messagesContainerRef}
            onUserScrollIntent={markUserScrollIntent}
          />
          <div className={styles.messages} ref={messagesContainerRef}>
            <CliInvocationBanner
              invocation={cliInvocation}
              sessionId={activeChatSessionRecord?.id}
            />
            {workspaceEnvironmentError && (
              <div className={styles.envErrorBanner} role="alert">
                <span>{workspaceEnvironmentError}</span>
                <button
                  type="button"
                  className={styles.envErrorRetry}
                  onClick={onRetryWorkspaceEnvironment}
                >
                  {t("retry_environment", "Retry environment setup")}
                </button>
              </div>
            )}
            {messages.length === 0 && !hasStreaming && !runningSetupScriptSource ? (
              <ChatEmptyState
                key={activeSessionId ?? "no-active-session"}
                workspaceEnvironmentPreparing={workspaceEnvironmentPreparing}
                workspaceId={selectedWorkspaceId}
              />
            ) : (
              <>
                {isLoadingMore && (
                  <div className={styles.loadingOlder}>
                    <LoaderCircle
                      size={14}
                      className={styles.loadingOlderSpinner}
                    />
                    Loading older messages…
                  </div>
                )}
                {activeSessionId && selectedWorkspaceId && (
                  <MessagesWithTurns
                    key={activeSessionId}
                    messages={messages}
                    workspaceId={selectedWorkspaceId}
                    sessionId={activeSessionId}
                    isRunning={isRunning}
                    onForkTurn={isRemote ? undefined : onForkTurn}
                    onAttachmentContextMenu={onAttachmentContextMenu}
                    onAttachmentClick={onAttachmentClick}
                    onOpenFileLink={rememberChatScrollPosition}
                    searchQuery={searchQuery}
                    globalOffset={globalOffset}
                    toolDisplayMode={toolDisplayMode}
                    liveTaskProgressNode={liveTaskProgressNode}
                    streamingThinkingNode={streamingThinkingNode}
                    streamingMessageNode={streamingMessageNode}
                  />
                )}

                {showChatAuthLoginPanel && (
                  <ChatAuthFailureCallout
                    autoStartKey={chatAuthLoginRequestId}
                    autoStartedKey={chatAuthLoginStartedRequestId}
                    onAutoStarted={setChatAuthLoginStartedRequestId}
                  />
                )}

                {runningSetupScriptSource && activeSessionId && (
                  <SetupScriptBanner
                    outcome={{
                      source: runningSetupScriptSource,
                      status: "running",
                      output: "",
                    }}
                    messageId={`setup-running:${activeSessionId}`}
                  />
                )}

                <PendingControlCards
                  activeSessionId={activeSessionId}
                  selectedWorkspaceId={selectedWorkspaceId}
                  ws={ws}
                  pendingQuestion={pendingQuestion}
                  pendingPlan={pendingPlan}
                  pendingApproval={pendingApproval}
                  clearAgentQuestion={clearAgentQuestion}
                  clearPlanApproval={clearPlanApproval}
                  clearAgentApproval={clearAgentApproval}
                  setError={setError}
                  onSend={onSend}
                />

                {isSteeringQueued && (
                  <div
                    className={styles.pendingSteer}
                    aria-live="polite"
                    aria-label={t("steer_pending_aria")}
                  >
                    <span className={styles.pendingSteerIcon} aria-hidden="true">
                      <SendHorizontal size={12} />
                    </span>
                    <span className={styles.pendingSteerLabel} aria-hidden="true">
                      {t("steer_pending_label")}
                    </span>
                    <span className={styles.pendingSteerContent}>
                      {pendingSteerContent ?? t("steer_pending_attachment")}
                    </span>
                  </div>
                )}

                {isRunning && !pendingQuestion && !pendingPlan && !pendingApproval && (
                  <ProcessingIndicator
                    workspaceId={selectedWorkspaceId}
                    isRunning={isRunning}
                    isCompacting={ws?.agent_status === "Compacting"}
                    processingRef={processingRef}
                  />
                )}

                {error && (
                  <ChatErrorBanner
                    message={error}
                    workspaceId={selectedWorkspaceId}
                    sessionId={activeSessionId}
                    onRecovered={() => setError(null)}
                  />
                )}
              </>
            )}
          </div>
        </ScrollContext.Provider>
      </div>

      {/* Sits above the scroll pill: a backgrounded workflow's card leaves
          the viewport within seconds (its launching turn ends almost
          immediately), so this is what keeps a multi-minute run visible. */}
      <WorkflowStatusPill sessionId={activeSessionId} />

      <ScrollToBottomPill
        visible={!isAtBottom && messages.length > 0}
        onClick={scrollToBottom}
      />

      {queuedMessages.length > 0 && activeSessionId && (
        <QueuedMessagesPopover
          queuedMessages={queuedMessages}
          isRemote={!!ws?.remote_connection_id}
          isRunning={isRunning}
          isSteeringQueued={isSteeringQueued}
          steerQueuedTooltip={steerQueuedTooltip}
          onEditingChange={(isEditing) =>
            setQueuedMessageEditing(activeSessionId, isEditing)
          }
          onClearQueue={() => clearQueuedMessagesAndCancelEdit(activeSessionId)}
          onRemoveMessage={(messageId) => removeQueuedMessage(activeSessionId, messageId)}
          onSteerMessage={onSteerQueuedMessage}
          onUpdateMessage={(messageId, updates) =>
            updateQueuedMessage(activeSessionId, messageId, updates)
          }
        />
      )}

      {selectedWorkspaceId && activeSessionId && (
        <ChatInputArea
          onSend={onSend}
          onSendSteer={onSendSteer}
          onSteerQueuedTop={onSteerQueuedTop}
          onRunShellCommand={onRunShellCommand}
          onStop={onStop}
          isRunning={isRunning}
          workspaceEnvironmentPreparing={workspaceEnvironmentPreparing}
          isRemote={!!ws?.remote_connection_id}
          hasQueuedMessages={queuedMessages.length > 0}
          selectedWorkspaceId={selectedWorkspaceId}
          sessionId={activeSessionId}
          repoId={repo?.id}
          projectPath={repo?.path}
          historyRef={historyRef}
          historyIndexRef={historyIndexRef}
          draftRef={draftRef}
          onAttachmentContextMenu={onAttachmentContextMenu}
          onAttachmentClick={onAttachmentClick}
        />
      )}
    </>
  );
}
