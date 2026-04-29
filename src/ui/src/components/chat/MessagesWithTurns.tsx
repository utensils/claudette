import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import type { CompletedTurn } from "../../stores/useAppStore";
import { loadAttachmentData } from "../../services/tauri";
import type { ChatMessage, ChatAttachment } from "../../types/chat";
import { roleClassKey, shouldRenderAsMarkdown } from "./messageRendering";
import { HighlightedMessageMarkdown } from "./HighlightedMessageMarkdown";
import { HighlightedPlainText } from "./HighlightedPlainText";
import { ThinkingBlock } from "./ThinkingBlock";
import { CompactionDivider } from "./CompactionDivider";
import { SyntheticContinuationMessage } from "./SyntheticContinuationMessage";
import { MessageAttachment, isTextDataMediaType } from "./MessageAttachment";
import {
  type DownloadableAttachment,
  openAttachmentWithDefaultApp,
} from "../../utils/attachmentDownload";
import {
  checkpointHasFileChanges,
  clearAllHasFileChanges,
  buildRollbackMap,
} from "../../utils/checkpointUtils";
import {
  assistantTextForTurn,
  buildPlainTurnFooters,
  findTriggeringUserIndex,
} from "../../utils/chatTurnFooter";
import {
  parseCompactionSentinel,
  parseSyntheticSummarySentinel,
} from "../../utils/compactionSentinel";
import { renderUltrathinkText } from "./ultrathink";
import {
  processActivities,
  turnHasTaskActivity,
} from "../../hooks/useTaskTracker";
import type { TaskTrackerResult, TrackedTask } from "../../hooks/useTaskTracker";
import { debugChat } from "../../utils/chatDebug";
import styles from "./ChatPanel.module.css";
import { TurnSummary } from "./TurnSummary";
import { TurnFooter } from "./TurnFooter";
import { PdfThumbnail } from "./PdfThumbnail";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  EMPTY_ATTACHMENTS,
  EMPTY_CHECKPOINTS,
  EMPTY_COMPLETED_TURNS,
  type RollbackModalData,
} from "./chatConstants";

/**
 * Renders all messages interleaved with completed turn summaries at the correct
 * chronological position. Uses a single store subscription + useMemo to avoid
 * per-message selectors and redundant re-renders during streaming.
 */
export const MessagesWithTurns = memo(function MessagesWithTurns({
  messages,
  workspaceId,
  sessionId,
  isRunning,
  onForkTurn,
  onAttachmentContextMenu,
  onAttachmentClick,
  searchQuery,
}: {
  messages: ChatMessage[];
  /** The enclosing workspace id — forwarded into rollback data so the modal
   *  can target the correct workspace (distinct from the session id after
   *  the multi-session refactor). */
  workspaceId: string;
  /** The active chat session id. All per-conversation store reads (turns,
   *  checkpoints, attachments, etc.) are now keyed by session id. */
  sessionId: string;
  isRunning: boolean;
  /** Handler invoked when the user forks a turn. Undefined disables the fork
   *  button (e.g. for remote workspaces where the command cannot run). */
  onForkTurn?: (checkpointId: string) => void;
  /** Right-click handler on message-image attachments. Lifted to ChatPanel so
   *  the context menu renders at the top of the component tree. The third
   *  argument is the persisted attachment id, used to lazy-load bytes for
   *  PDFs (whose data_base64 is stripped on hydration). */
  onAttachmentContextMenu?: (
    e: React.MouseEvent,
    attachment: DownloadableAttachment,
    attachmentId?: string,
  ) => void;
  /** Left-click handler on message-image attachments — opens the lightbox. */
  onAttachmentClick?: (
    e: React.MouseEvent,
    attachment: DownloadableAttachment,
  ) => void;
  /** Active chat-search query (Cmd/Ctrl+F). Empty string when the bar is
   *  closed; non-empty values trigger highlight wrappers on each message. */
  searchQuery: string;
}) {
  const { t } = useTranslation("chat");
  const completedTurns = useAppStore(
    (s) => s.completedTurns[sessionId] ?? EMPTY_COMPLETED_TURNS,
  );
  const toggleCompletedTurn = useAppStore((s) => s.toggleCompletedTurn);
  const checkpoints = useAppStore(
    (s) => s.checkpoints[sessionId] ?? EMPTY_CHECKPOINTS,
  );
  const openModal = useAppStore((s) => s.openModal);
  const showThinkingBlocks = useAppStore(
    (s) => s.showThinkingBlocks[sessionId] === true,
  );
  // While the typewriter is finishing the drain after streamingContent cleared,
  // hide the just-added completed assistant message — StreamingMessage renders
  // it in-place, so showing both would duplicate the text.
  const pendingMessageId = useAppStore(
    (s) => s.pendingTypewriter[sessionId]?.messageId ?? null,
  );
  const chatAttachments = useAppStore(
    (s) => s.chatAttachments[sessionId] ?? EMPTY_ATTACHMENTS,
  );
  const worktreePath = useAppStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.worktree_path,
  );

  // Pre-build a Map keyed by message_id for O(1) lookup in the render loop.
  //
  // Agent-origin attachments are persisted with `message_id` set to the *user*
  // message that triggered the turn (FK-cascade-safe). For display they
  // belong with the *assistant* message of the same turn — i.e. the next
  // Assistant message after the FK anchor in chronological order. This
  // re-route happens here so the storage shape can stay simple.
  const attachmentsByMessage = useMemo(() => {
    // Single reverse pass: each User message maps to the most recent
    // Assistant message that follows it. O(n) instead of O(n²).
    const userToNextAssistant = new Map<string, string>();
    let nextAssistantId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "Assistant") {
        nextAssistantId = m.id;
      } else if (m.role === "User" && nextAssistantId) {
        userToNextAssistant.set(m.id, nextAssistantId);
      }
    }
    const map = new Map<string, ChatAttachment[]>();
    for (const att of chatAttachments) {
      const targetId =
        att.origin === "agent"
          ? (userToNextAssistant.get(att.message_id) ?? att.message_id)
          : att.message_id;
      const list = map.get(targetId);
      if (list) list.push(att);
      else map.set(targetId, [att]);
    }
    return map;
  }, [chatAttachments, messages]);

  // Build an index: afterMessageIndex → array of (turn, globalIndex) pairs.
  // Only recomputed when completedTurns changes, not on every streaming update.
  const turnsByPosition = useMemo(() => {
    const map: Record<number, Array<{ turn: CompletedTurn; globalIdx: number }>> = {};
    completedTurns.forEach((turn, globalIdx) => {
      const key = turn.afterMessageIndex;
      (map[key] ??= []).push({ turn, globalIdx });
    });
    return map;
  }, [completedTurns]);

  const completedTurnPositions = useMemo(
    () => new Set(completedTurns.map((turn) => turn.afterMessageIndex)),
    [completedTurns],
  );

  const findTriggeringUserIdx = useCallback(
    (afterMessageIndex: number) => {
      return findTriggeringUserIndex(messages, afterMessageIndex);
    },
    [messages],
  );

  // Map user message index → checkpoint for rollback buttons.
  // Each user message maps to the latest preceding checkpoint, with the first
  // user message mapping to null so it can clear the whole conversation.
  const rollbackCheckpointByIdx = useMemo(
    () => buildRollbackMap(messages, checkpoints),
    [messages, checkpoints],
  );

  const buildRollbackData = useCallback(
    (userIdx: number): RollbackModalData | null => {
      if (!rollbackCheckpointByIdx.has(userIdx)) return null;
      const target = rollbackCheckpointByIdx.get(userIdx) ?? null;
      const userMsg = messages[userIdx];
      if (!userMsg) return null;
      return {
        workspaceId,
        sessionId,
        checkpointId: target ? target.id : null,
        messageId: userMsg.id,
        messagePreview: userMsg.content.slice(0, 100),
        messageContent: userMsg.content,
        hasFileChanges: target
          ? checkpointHasFileChanges(target, checkpoints)
          : clearAllHasFileChanges(checkpoints),
      };
    },
    [checkpoints, messages, rollbackCheckpointByIdx, workspaceId, sessionId],
  );

  // Joined assistant text per turn, used by the "Copy output" action in the
  // turn footer. CompletedTurn is only persisted for tool-using turns, so the
  // slice starts at the nearest preceding user message instead of the previous
  // CompletedTurn boundary.
  const assistantTextByTurnId = useMemo(() => {
    const map = new Map<string, string>();
    for (const turn of completedTurns) {
      const userIdx = findTriggeringUserIdx(turn.afterMessageIndex);
      if (userIdx === -1) {
        map.set(turn.id, "");
        continue;
      }
      map.set(
        turn.id,
        assistantTextForTurn(messages, userIdx, turn.afterMessageIndex),
      );
    }
    return map;
  }, [completedTurns, findTriggeringUserIdx, messages]);

  // Per-turn rollback data, keyed by turn.id. Completed turns are only
  // persisted for tool-using turns, so the triggering user is the nearest
  // user message before the completed turn boundary.
  const rollbackByTurnId = useMemo(() => {
    const result = new Map<string, RollbackModalData>();
    for (const turn of completedTurns) {
      const userIdx = findTriggeringUserIdx(turn.afterMessageIndex);
      if (userIdx === -1) continue;
      const data = buildRollbackData(userIdx);
      if (data) result.set(turn.id, data);
    }
    return result;
  }, [buildRollbackData, completedTurns, findTriggeringUserIdx]);

  const buildOnRollback = (turnId: string) => {
    if (isRunning) return undefined;
    const data = rollbackByTurnId.get(turnId);
    if (!data) return undefined;
    return () => openModal("rollback", data);
  };

  const plainTurnFootersByPosition = useMemo(() => {
    return buildPlainTurnFooters(
      messages,
      rollbackCheckpointByIdx,
      completedTurnPositions,
      checkpoints,
    );
  }, [checkpoints, completedTurnPositions, messages, rollbackCheckpointByIdx]);

  const renderPlainTurnFooter = (position: number) => {
    const data = plainTurnFootersByPosition.get(position);
    if (!data) return null;
    const rollbackData = buildRollbackData(data.userIdx);
    const onRollback =
      !isRunning && rollbackData
        ? () => openModal("rollback", rollbackData)
        : undefined;
    const onFork =
      data.forkCheckpointId && onForkTurn
        ? () => onForkTurn(data.forkCheckpointId!)
        : undefined;
    const hasRenderableTokens =
      typeof data.inputTokens === "number" &&
      typeof data.outputTokens === "number";

    if (
      !data.assistantText &&
      !data.durationMs &&
      !hasRenderableTokens &&
      !onFork &&
      !onRollback
    ) {
      return null;
    }

    return (
      <TurnFooter
        key={`plain-turn-footer-${data.position}`}
        durationMs={data.durationMs}
        inputTokens={data.inputTokens}
        outputTokens={data.outputTokens}
        assistantText={data.assistantText}
        onFork={onFork}
        onRollback={onRollback}
        className={styles.messageTurnFooter}
      />
    );
  };

  // Compute cumulative task progress at each turn index in a single O(n) pass.
  // Carries taskMap/todoMap forward across iterations instead of re-slicing.
  const taskProgressByTurn = useMemo(() => {
    const map = new Map<number, TaskTrackerResult>();
    const taskMap = new Map<string, TrackedTask>();
    const todoMap = new Map<string, TrackedTask>();
    const nextSyntheticId = { value: 1 };
    let anyTasksSoFar = false;

    for (let i = 0; i < completedTurns.length; i++) {
      processActivities(completedTurns[i].activities, taskMap, todoMap, nextSyntheticId);
      if (turnHasTaskActivity(completedTurns[i])) {
        anyTasksSoFar = true;
      }
      if (anyTasksSoFar) {
        const tasks = [...taskMap.values(), ...todoMap.values()];
        const completedCount = tasks.filter((task) => task.status === "completed").length;
        map.set(i, { tasks, completedCount, totalCount: tasks.length });
      }
    }
    return map;
  }, [completedTurns]);

  useEffect(() => {
    debugChat("MessagesWithTurns", "layout", {
      workspaceId,
      sessionId,
      messageIds: messages.map((msg) => msg.id),
      turnLayout: completedTurns.map((turn) => ({
        id: turn.id,
        afterMessageIndex: turn.afterMessageIndex,
        postLastMessage: turn.afterMessageIndex >= messages.length,
        toolCount: turn.activities.length,
      })),
    });
  }, [workspaceId, sessionId, messages, completedTurns]);

  const renderTurns = (position: number) => {
    const entries = turnsByPosition[position];
    if (!entries) return null;
    return entries.map(({ turn, globalIdx }) => (
      <TurnSummary
        key={turn.id}
        turn={turn}
        collapsed={turn.collapsed}
        onToggle={() => toggleCompletedTurn(sessionId, globalIdx)}
        taskProgress={taskProgressByTurn.get(globalIdx)}
        assistantText={assistantTextByTurnId.get(turn.id) ?? ""}
        onFork={onForkTurn ? () => onForkTurn(turn.id) : undefined}
        onRollback={buildOnRollback(turn.id)}
        searchQuery={searchQuery}
        worktreePath={worktreePath}
      />
    ));
  };

  return (
    <>
      {messages.map((msg, idx) => {
        // Sentinel dispatch for System messages — must precede the generic
        // message bubble so compaction/synthetic-summary messages render
        // as their own dedicated components.
        if (msg.role === "System" && msg.id !== pendingMessageId) {
          const compaction = parseCompactionSentinel(msg.content);
          if (compaction) {
            return (
              <React.Fragment key={msg.id}>
                {renderTurns(idx)}
                <CompactionDivider
                  event={{
                    ...compaction,
                    timestamp: msg.created_at,
                    afterMessageIndex: idx,
                  }}
                />
              </React.Fragment>
            );
          }
          const syntheticBody = parseSyntheticSummarySentinel(msg.content);
          if (syntheticBody !== null) {
            return (
              <React.Fragment key={msg.id}>
                {renderTurns(idx)}
                <SyntheticContinuationMessage body={syntheticBody} />
              </React.Fragment>
            );
          }
        }
        // Default rendering for User, Assistant, and non-sentinel System messages.
        return (
          <React.Fragment key={msg.id}>
            {renderTurns(idx)}
            {msg.id === pendingMessageId ? null : (
              <div className={`${styles.message} ${styles[roleClassKey(msg.role, msg.content)]}`}>
                {msg.role === "User" && (
                  <div className={styles.roleLabel}>{t("you_label")}</div>
                )}
                {msg.role === "User" && msg.content.length > 0 && (
                  <MessageCopyButton
                    text={msg.content}
                    className={styles.userMessageCopyButton}
                  />
                )}
                {msg.role === "Assistant" && msg.thinking && showThinkingBlocks && (
                  <ThinkingBlock content={msg.thinking} isStreaming={false} searchQuery={searchQuery} />
                )}
                <div className={styles.content}>
                  {attachmentsByMessage.has(msg.id) && (
                    <div className={styles.messageImages}>
                      {attachmentsByMessage.get(msg.id)!.map((att) => {
                        if (att.media_type === "application/pdf") {
                          return (
                            <PdfThumbnail
                              key={att.id}
                              dataBase64={att.data_base64 || undefined}
                              attachmentId={att.id}
                              filename={att.filename}
                              className={styles.messageImage}
                              onClick={() => {
                                (async () => {
                                  // Persisted attachments strip data_base64 on first
                                  // load to avoid IPC bloat — fetch on demand.
                                  let b64 = att.data_base64;
                                  if (!b64) {
                                    b64 = await loadAttachmentData(att.id);
                                  }
                                  await openAttachmentWithDefaultApp({
                                    filename: att.filename,
                                    media_type: att.media_type,
                                    data_base64: b64,
                                  });
                                })().catch((err) =>
                                  console.error("Failed to open PDF:", err),
                                );
                              }}
                              onContextMenu={(e) =>
                                onAttachmentContextMenu?.(
                                  e,
                                  {
                                    filename: att.filename,
                                    media_type: att.media_type,
                                    data_base64: att.data_base64,
                                  },
                                  att.id,
                                )
                              }
                            />
                          );
                        }
                        if (isTextDataMediaType(att.media_type)) {
                          return (
                            <MessageAttachment
                              key={att.id}
                              attachment={att}
                              handlers={{ onContextMenu: onAttachmentContextMenu }}
                            />
                          );
                        }
                        return (
                          <img
                            key={att.id}
                            src={`data:${att.media_type};base64,${att.data_base64}`}
                            alt={att.filename}
                            className={styles.messageImage}
                            onClick={(e) =>
                              onAttachmentClick?.(e, {
                                filename: att.filename,
                                media_type: att.media_type,
                                data_base64: att.data_base64,
                              })
                            }
                            onContextMenu={(e) =>
                              onAttachmentContextMenu?.(
                                e,
                                {
                                  filename: att.filename,
                                  media_type: att.media_type,
                                  data_base64: att.data_base64,
                                },
                                att.id,
                              )
                            }
                          />
                        );
                      })}
                    </div>
                  )}
                  {shouldRenderAsMarkdown(msg.role) ? (
                    // Assistant + System: run through Markdown so plan-mode dumps,
                    // setup-script output, and other multi-line system notes
                    // preserve headings, lists, and code blocks instead of
                    // collapsing newlines into a single paragraph.
                    <HighlightedMessageMarkdown content={msg.content} query={searchQuery} />
                  ) : searchQuery ? (
                    // While the search bar is open, render user messages as plain
                    // highlighted text so matches inside them get marked. The
                    // ultrathink rainbow animation is suppressed in this mode —
                    // searchability wins over the easter egg.
                    <HighlightedPlainText text={msg.content} query={searchQuery} />
                  ) : (
                    renderUltrathinkText(msg.content, {
                      animated: false,
                      styles: {
                        ultrathinkChar: styles.ultrathinkChar,
                        ultrathinkCharAnimated: styles.ultrathinkCharAnimated,
                      },
                    })
                  )}
                </div>
              </div>
            )}
            {renderPlainTurnFooter(idx + 1)}
          </React.Fragment>
        );
      })}
      {/* Turns that finalized after or at the last message index */}
      {completedTurns
        .map((turn, globalIdx) => ({ turn, globalIdx }))
        .filter(({ turn }) => turn.afterMessageIndex >= messages.length)
        .map(({ turn, globalIdx }) => (
          <TurnSummary
            key={turn.id}
            turn={turn}
            collapsed={turn.collapsed}
            onToggle={() => toggleCompletedTurn(sessionId, globalIdx)}
            taskProgress={taskProgressByTurn.get(globalIdx)}
            assistantText={assistantTextByTurnId.get(turn.id) ?? ""}
            onFork={onForkTurn ? () => onForkTurn(turn.id) : undefined}
            onRollback={buildOnRollback(turn.id)}
            searchQuery={searchQuery}
            worktreePath={worktreePath}
          />
        ))}
    </>
  );
});
