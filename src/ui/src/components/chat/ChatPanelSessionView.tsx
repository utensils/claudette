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
import {
  submitAgentAnswer,
  submitAgentApproval,
  submitPlanApproval,
} from "../../services/tauri";
import { ChatAuthFailureCallout } from "../auth/ChatAuthFailureCallout";
import { AgentApprovalCard } from "./AgentApprovalCard";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { ChatEmptyState } from "./ChatEmptyState";
import { ChatErrorBanner } from "./ChatErrorBanner";
import { ChatInputArea } from "./ChatInputArea";
import { ChatSearchBar } from "./ChatSearchBar";
import { CliInvocationBanner } from "./CliInvocationBanner";
import { CurrentTurnTaskProgress } from "./CurrentTurnTaskProgress";
import { MessagesWithTurns } from "./MessagesWithTurns";
import { OverlayScrollbar } from "./OverlayScrollbar";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { setPlanModeAndPersist } from "./planModePersistence";
import { QueuedMessagesPopover } from "./QueuedMessagesPopover";
import { ScrollContext } from "./ScrollContext";
import { ScrollToBottomPill } from "./ScrollToBottomPill";
import { SetupScriptBanner } from "./SetupScriptBanner";
import { StreamingMessage } from "./StreamingMessage";
import { StreamingThinkingBlock } from "./StreamingThinkingBlock";
import { formatElapsedSeconds } from "./chatHelpers";
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
  elapsed: number;
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
  elapsed,
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
  const formatElapsed = formatElapsedSeconds;

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
                    liveTaskProgressNode={
                      activitiesCount > 0 ? (
                        <CurrentTurnTaskProgress sessionId={activeSessionId} />
                      ) : null
                    }
                    streamingThinkingNode={
                      hasThinking && showThinkingBlocks ? (
                        <StreamingThinkingBlock
                          sessionId={activeSessionId}
                          isStreaming={isRunning ?? false}
                          inline={toolDisplayMode === "inline"}
                          searchQuery={searchQuery}
                        />
                      ) : null
                    }
                    streamingMessageNode={
                      hasStreaming || hasPendingTypewriter ? (
                        <StreamingMessage
                          sessionId={activeSessionId}
                          workspaceId={selectedWorkspaceId}
                          isStreaming={isRunning ?? false}
                          searchQuery={searchQuery}
                        />
                      ) : null
                    }
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

                {pendingQuestion && (
                  <AgentQuestionCard
                    question={pendingQuestion}
                    onRespond={async (answers) => {
                      if (!activeSessionId) return;
                      const sid = activeSessionId;
                      const toolUseId = pendingQuestion.toolUseId;
                      try {
                        await submitAgentAnswer(sid, toolUseId, answers);
                        clearAgentQuestion(sid);
                      } catch (e) {
                        console.error("Failed to submit agent answer:", e);
                        setError(String(e));
                      }
                    }}
                  />
                )}

                {pendingPlan && selectedWorkspaceId && (
                  <PlanApprovalCard
                    approval={pendingPlan}
                    workspaceId={selectedWorkspaceId}
                    remoteConnectionId={ws?.remote_connection_id ?? undefined}
                    onRespond={async (approved, reason) => {
                      if (!activeSessionId) return;
                      const sid = activeSessionId;
                      const toolUseId = pendingPlan.toolUseId;
                      const codexPlanApproval = pendingPlan.source === "codex";
                      try {
                        await submitPlanApproval(sid, toolUseId, approved, reason);
                        clearPlanApproval(sid);
                        if (codexPlanApproval) {
                          if (approved) {
                            await setPlanModeAndPersist(sid, false);
                            await onSend("Implement the plan.");
                          } else if (reason?.trim()) {
                            await setPlanModeAndPersist(sid, true);
                            await onSend(
                              `${reason.trim()}\n\nRevise the plan to address this feedback. Do not begin implementation.`,
                            );
                          }
                        } else {
                          await setPlanModeAndPersist(sid, false);
                        }
                      } catch (e) {
                        console.error("Failed to submit plan approval:", e);
                        setError(String(e));
                      }
                    }}
                  />
                )}

                {pendingApproval && (
                  <AgentApprovalCard
                    approval={pendingApproval}
                    onRespond={async (approved, reason) => {
                      if (!activeSessionId) return;
                      const sid = activeSessionId;
                      const toolUseId = pendingApproval.toolUseId;
                      try {
                        await submitAgentApproval(sid, toolUseId, approved, reason);
                        clearAgentApproval(sid);
                      } catch (e) {
                        console.error("Failed to submit agent approval:", e);
                        setError(String(e));
                      }
                    }}
                  />
                )}

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
                  <div
                    ref={processingRef}
                    className={styles.processing}
                    role="status"
                    aria-label={
                      ws?.agent_status === "Compacting"
                        ? t("compacting_aria", {
                            elapsed: formatElapsed(elapsed),
                          })
                        : t("processing_aria", {
                            elapsed: formatElapsed(elapsed),
                          })
                    }
                  >
                    <span className={styles.spinnerWrap} aria-hidden="true">
                      <span className={styles.spinner} />
                    </span>
                    {ws?.agent_status === "Compacting" && (
                      <span className={styles.compactingLabel}>
                        {t("compacting_label")}
                      </span>
                    )}
                    <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
                  </div>
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
