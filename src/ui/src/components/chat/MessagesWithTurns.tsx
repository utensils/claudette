import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import { loadAttachmentData } from "../../services/tauri";
import type { ChatMessage, ChatAttachment } from "../../types/chat";
import { roleClassKey, shouldRenderAsMarkdown } from "./messageRendering";
import { HighlightedMessageMarkdown } from "./HighlightedMessageMarkdown";
import { HighlightedPlainText } from "./HighlightedPlainText";
import { relativizePath } from "../../hooks/toolSummary";
import { ThinkingBlock } from "./ThinkingBlock";
import { collapsedToolGroupKey } from "./collapsedToolGroupKey";
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
import { ToolActivitiesSection } from "./ToolActivitiesSection";
import { TurnFooter } from "./TurnFooter";
import { TurnEditSummaryCard } from "./EditChangeSummary";
import {
  summarizeTurnEdits,
} from "./editActivitySummary";
import { PdfThumbnail } from "./PdfThumbnail";
import { MessageCopyButton } from "./MessageCopyButton";
import { groupToolActivitiesForDisplay } from "./toolActivityGroups";
import {
  EMPTY_ACTIVITIES,
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
  globalOffset = 0,
  toolDisplayMode,
  liveTaskProgressNode,
  streamingThinkingNode,
  streamingMessageNode,
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
  /** 0-based index of the first loaded message in the full session message
   *  sequence. Zero for fully-loaded sessions; positive when older messages
   *  have not been fetched yet (pagination). Used to match CompletedTurn
   *  positions (which are global) against the local message array. */
  globalOffset?: number;
  toolDisplayMode: ToolDisplayMode;
  liveTaskProgressNode?: React.ReactNode;
  streamingThinkingNode?: React.ReactNode;
  streamingMessageNode?: React.ReactNode;
}) {
  const { t } = useTranslation("chat");
  const completedTurns = useAppStore(
    (s) => s.completedTurns[sessionId] ?? EMPTY_COMPLETED_TURNS,
  );
  // Retained for the rare path where every group of a turn shares the
  // same id and a per-turn toggle is what we want; today's
  // chronological-split rendering uses the per-group setter below.
  const toggleCompletedTurn = useAppStore((s) => s.toggleCompletedTurn);
  const collapsedToolGroups = useAppStore(
    (s) => s.collapsedToolGroupsBySession[sessionId],
  );
  const setCollapsedToolGroup = useAppStore((s) => s.setCollapsedToolGroup);
  const checkpoints = useAppStore(
    (s) => s.checkpoints[sessionId] ?? EMPTY_CHECKPOINTS,
  );
  const openModal = useAppStore((s) => s.openModal);
  const showThinkingBlocks = useAppStore(
    (s) => s.showThinkingBlocks[sessionId] === true,
  );
  const chatAttachments = useAppStore(
    (s) => s.chatAttachments[sessionId] ?? EMPTY_ATTACHMENTS,
  );
  const worktreePath = useAppStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.worktree_path,
  );
  const liveToolActivities = useAppStore(
    (s) => s.toolActivities[sessionId] ?? EMPTY_ACTIVITIES,
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
    const loadedMessageIds = new Set<string>();
    let nextAssistantId: string | null = null;
    let firstAssistantInWindow: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      loadedMessageIds.add(m.id);
      if (m.role === "Assistant") {
        nextAssistantId = m.id;
        firstAssistantInWindow = m.id;
      } else if (m.role === "User" && nextAssistantId) {
        userToNextAssistant.set(m.id, nextAssistantId);
      }
    }
    // Detect a mid-turn page start: the first non-System row at the top of
    // the window is an Assistant. Pages can begin with a System sentinel
    // (e.g. compaction marker) before the carry-over assistant, so we can't
    // just check messages[0].role.
    const firstNonSystem = messages.find((m) => m.role !== "System");
    const startsMidTurn = firstNonSystem?.role === "Assistant";
    const map = new Map<string, ChatAttachment[]>();
    for (const att of chatAttachments) {
      let targetId: string;
      if (att.origin === "agent") {
        // Anchor user is in the loaded window: route to the assistant of
        // that turn. Anchor user is NOT loaded but the page begins mid-turn:
        // the orphan agent rows belong to the carry-over assistant — i.e.
        // the first Assistant message at the top of the loaded window.
        // Otherwise fall back to the raw anchor (which won't render — that's
        // intentional for stale attachments whose turn is fully out-of-view).
        const routed = userToNextAssistant.get(att.message_id);
        if (routed) {
          targetId = routed;
        } else if (
          !loadedMessageIds.has(att.message_id) &&
          firstAssistantInWindow !== null &&
          startsMidTurn
        ) {
          targetId = firstAssistantInWindow;
        } else {
          targetId = att.message_id;
        }
      } else {
        targetId = att.message_id;
      }
      const list = map.get(targetId);
      if (list) list.push(att);
      else map.set(targetId, [att]);
    }
    return map;
  }, [chatAttachments, messages]);

  // CompletedTurn.afterMessageIndex is GLOBAL (counts from message 0 of the
  // session, not from the loaded window). Shift to local before indexing into
  // the `messages` array; otherwise older summaries' "Copy output", rollback,
  // and fork actions would target the wrong message once the loaded window
  // contains more than one user message.
  const findTriggeringUserIdx = useCallback(
    (afterMessageIndex: number) => {
      const localAfter = afterMessageIndex - globalOffset;
      if (localAfter <= 0) return -1;
      return findTriggeringUserIndex(messages, localAfter);
    },
    [messages, globalOffset],
  );

  const chronologicalTurnLayout = useMemo(() => {
    const groupsByPosition: Record<
      number,
      Array<{
        turn: CompletedTurn;
        globalIdx: number;
        activities: CompletedTurn["activities"];
        label: string;
        showFooter: boolean;
      }>
    > = {};
    const finalFooterByPosition: Record<
      number,
      Array<{ turn: CompletedTurn; globalIdx: number }>
    > = {};
    const positions = new Set<number>();

    completedTurns.forEach((turn, globalIdx) => {
      const localAfter = turn.afterMessageIndex - globalOffset;
      const userIdx = findTriggeringUserIdx(turn.afterMessageIndex);
      const assistantPositions: number[] = [];

      if (userIdx !== -1) {
        const end = Math.min(localAfter, messages.length);
        for (let idx = userIdx + 1; idx < end; idx++) {
          if (messages[idx]?.role === "Assistant") {
            assistantPositions.push(globalOffset + idx + 1);
          }
        }
      }

      const positionForOrdinal = (ordinal: number | undefined) => {
        if (userIdx === -1) return turn.afterMessageIndex;
        if (typeof ordinal !== "number" || ordinal < 0) {
          return turn.afterMessageIndex;
        }
        const safeOrdinal = ordinal;
        if (safeOrdinal === 0) return globalOffset + userIdx + 1;
        return assistantPositions[safeOrdinal - 1] ?? turn.afterMessageIndex;
      };

      const activitiesByPosition = new Map<number, CompletedTurn["activities"]>();
      for (const activity of turn.activities) {
        const position = positionForOrdinal(activity.assistantMessageOrdinal);
        const existing = activitiesByPosition.get(position);
        if (existing) existing.push(activity);
        else activitiesByPosition.set(position, [activity]);
      }

      let hasFinalGroup = false;
      for (const [position, activities] of activitiesByPosition) {
        positions.add(position);
        const displayGroups = groupToolActivitiesForDisplay(
          activities,
          toolDisplayMode,
        );
        const finalGroupIndex =
          position === turn.afterMessageIndex ? displayGroups.length - 1 : -1;
        hasFinalGroup ||= finalGroupIndex >= 0;
        displayGroups.forEach((group, groupIndex) => {
          (groupsByPosition[position] ??= []).push({
            turn,
            globalIdx,
            activities: group.activities,
            label: group.label,
            showFooter: groupIndex === finalGroupIndex,
          });
        });
      }

      positions.add(turn.afterMessageIndex);
      if (!hasFinalGroup) {
        (finalFooterByPosition[turn.afterMessageIndex] ??= []).push({
          turn,
          globalIdx,
        });
      }
    });

    return { groupsByPosition, finalFooterByPosition, positions };
  }, [completedTurns, findTriggeringUserIdx, globalOffset, messages, toolDisplayMode]);

  const completedTurnPositions = chronologicalTurnLayout.positions;

  const liveToolActivitiesByPosition = useMemo(() => {
    const activitiesByPosition = new Map<number, ToolActivity[]>();
    if (liveToolActivities.length === 0) return activitiesByPosition;

    let userIdx = -1;
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      if (messages[idx]?.role === "User") {
        userIdx = idx;
        break;
      }
    }

    const assistantPositions: number[] = [];
    if (userIdx !== -1) {
      for (let idx = userIdx + 1; idx < messages.length; idx++) {
        if (messages[idx]?.role === "Assistant") {
          assistantPositions.push(globalOffset + idx + 1);
        }
      }
    }

    const positionForOrdinal = (ordinal: number | undefined) => {
      const tailPosition = globalOffset + messages.length;
      if (userIdx === -1) return tailPosition;
      if (typeof ordinal !== "number" || ordinal < 0) return tailPosition;
      if (ordinal === 0) return globalOffset + userIdx + 1;
      return assistantPositions[ordinal - 1] ?? tailPosition;
    };

    for (const activity of liveToolActivities) {
      const position = positionForOrdinal(activity.assistantMessageOrdinal);
      const existing = activitiesByPosition.get(position);
      if (existing) existing.push(activity);
      else activitiesByPosition.set(position, [activity]);
    }

    return activitiesByPosition;
  }, [globalOffset, liveToolActivities, messages]);

  // Local version of completedTurnPositions with global indices shifted to
  // local array indices. Used by buildPlainTurnFooters, which works in local
  // index space, so it correctly suppresses plain footers at positions that
  // already have a TurnSummary even when older messages are paginated out.
  const localCompletedTurnPositions = useMemo(
    () =>
      new Set(
        [...completedTurnPositions]
          .map((p) => p - globalOffset)
          .filter((p) => p >= 0 && p <= messages.length),
      ),
    [completedTurnPositions, globalOffset, messages.length],
  );

  // Map user message index → checkpoint for rollback buttons.
  // Each user message maps to the latest preceding checkpoint. The first user
  // message in the FULL conversation gets `null` (clear-all) — but on a
  // paginated window the first row might not be the conversation root, so
  // pass `globalOffset` through to suppress the clear-all sentinel.
  const rollbackCheckpointByIdx = useMemo(
    () => buildRollbackMap(messages, checkpoints, globalOffset),
    [messages, checkpoints, globalOffset],
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
      // assistantTextForTurn slices the messages array — pass the LOCAL turn
      // boundary (afterMessageIndex - globalOffset), not the global value.
      map.set(
        turn.id,
        assistantTextForTurn(
          messages,
          userIdx,
          turn.afterMessageIndex - globalOffset,
        ),
      );
    }
    return map;
  }, [completedTurns, findTriggeringUserIdx, messages, globalOffset]);

  const editSummaryByTurnId = useMemo(() => {
    const map = new Map<string, ReturnType<typeof summarizeTurnEdits>>();
    for (const turn of completedTurns) {
      map.set(turn.id, summarizeTurnEdits(turn.activities));
    }
    return map;
  }, [completedTurns]);
  const openFileTab = useAppStore((s) => s.openFileTab);
  // Open the file in the Monaco editor tab (not the diff viewer).
  // Activity-derived edits use absolute paths (the agent's full path
  // including the worktree prefix); the file-tab store keys by repo-
  // relative path, so strip the worktree prefix when present.
  // `relativizePath` handles both `/` and `\` so this works on Windows
  // worktrees too. If the result still looks absolute (POSIX `/...`
  // or Windows `C:\...` / `C:/...`), the file isn't reachable via the
  // current worktree — bail rather than passing a bad key into the
  // file-tab store.
  const openFileInMonaco = useCallback(
    (filePath: string) => {
      const rel = relativizePath(filePath, worktreePath);
      if (/^([a-zA-Z]:[\\/]|[\\/])/.test(rel)) return;
      openFileTab(workspaceId, rel);
    },
    [openFileTab, workspaceId, worktreePath],
  );

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
      localCompletedTurnPositions,
      checkpoints,
    );
  }, [checkpoints, localCompletedTurnPositions, messages, rollbackCheckpointByIdx]);

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
        postLastMessage: turn.afterMessageIndex >= globalOffset + messages.length,
        toolCount: turn.activities.length,
      })),
    });
  }, [workspaceId, sessionId, messages, completedTurns, globalOffset]);

  const renderTurns = (position: number) => {
    const groupEntries = chronologicalTurnLayout.groupsByPosition[position] ?? [];
    const footerEntries = chronologicalTurnLayout.finalFooterByPosition[position] ?? [];
    if (groupEntries.length === 0 && footerEntries.length === 0) return null;
    return (
      <>
        {groupEntries.map(({ turn, globalIdx, activities, label, showFooter }) => {
          // A single turn can produce multiple display groups when
          // chronologically-interleaved messages split its activities;
          // each group needs its own collapse state so clicking one
          // chevron doesn't drag every sibling group's expansion with
          // it.
          //
          // The key intentionally drops `turn.id` and matches the live
          // `GroupedToolActivityRows` key format — see
          // `collapsedToolGroupKey` for the rationale: the same
          // activity moves from `toolActivities[sessionId]` into
          // `completedTurns[sessionId][N].activities` when the turn
          // ends, but its `toolUseId` is preserved verbatim. Sharing
          // the key across both surfaces means a user-toggled
          // expand/collapse choice made while running survives the
          // turn-end transition.
          //
          // When no override has been set yet, fall back to
          // `turn.collapsed` so the turn-level persisted state still
          // seeds the initial view of replayed-from-DB completed turns.
          const groupKey =
            collapsedToolGroupKey(activities) ??
            // Synthetic fallback for the (impossible-in-practice)
            // empty-activities case — keep keys session-unique without
            // accidentally colliding with a real tool group.
            `tools:__empty__:${turn.id}`;
          const userOverride = collapsedToolGroups?.[groupKey];
          const collapsed = userOverride ?? turn.collapsed;
          // Single-group turns also flip the legacy `turn.collapsed`
          // flag so persistence-aware code (Cmd-A "collapse all" etc.)
          // sees the same state without needing to consult the override
          // map. Multi-group turns only mutate the per-group override —
          // touching `turn.collapsed` there would re-create the original
          // bug.
          const isSingleGroupTurn =
            (chronologicalTurnLayout.groupsByPosition[position] ?? []).filter(
              (g) => g.globalIdx === globalIdx,
            ).length === 1;
          const onToggle = () => {
            const next = !collapsed;
            setCollapsedToolGroup(sessionId, groupKey, next);
            if (isSingleGroupTurn && next !== turn.collapsed) {
              toggleCompletedTurn(sessionId, globalIdx);
            }
          };
          return (
            <TurnSummary
              key={`${turn.id}:${position}:${label}:${activities[0]?.toolUseId ?? "empty"}`}
              turn={turn}
              activities={activities}
              label={label}
              inline={toolDisplayMode === "inline"}
              showFooter={showFooter}
              collapsed={collapsed}
              onToggle={onToggle}
              taskProgress={showFooter ? taskProgressByTurn.get(globalIdx) : undefined}
              assistantText={showFooter ? (assistantTextByTurnId.get(turn.id) ?? "") : ""}
              onFork={showFooter && onForkTurn ? () => onForkTurn(turn.id) : undefined}
              onRollback={showFooter ? buildOnRollback(turn.id) : undefined}
              searchQuery={searchQuery}
              worktreePath={worktreePath}
              onOpenEditFile={showFooter ? openFileInMonaco : undefined}
            />
          );
        })}
        {footerEntries.map(({ turn }) => {
          const turnActivitySummary = editSummaryByTurnId.get(turn.id) ?? null;
          return (
            <React.Fragment key={`${turn.id}:${position}:footer`}>
              {turnActivitySummary && (
                <TurnEditSummaryCard
                  summary={turnActivitySummary}
                  searchQuery={searchQuery}
                  worktreePath={worktreePath}
                  onOpenFile={openFileInMonaco}
                />
              )}
              <TurnFooter
                durationMs={turn.durationMs}
                inputTokens={turn.inputTokens}
                outputTokens={turn.outputTokens}
                assistantText={assistantTextByTurnId.get(turn.id) || undefined}
                onFork={onForkTurn ? () => onForkTurn(turn.id) : undefined}
                onRollback={buildOnRollback(turn.id)}
                className={styles.messageTurnFooter}
              />
            </React.Fragment>
          );
        })}
      </>
    );
  };

  const renderLiveToolActivity = (position: number) => {
    const activities = liveToolActivitiesByPosition.get(position);
    if (!activities) return null;
    return (
      <ToolActivitiesSection
        key={`live-tool-activity-${position}`}
        sessionId={sessionId}
        toolDisplayMode={toolDisplayMode}
        searchQuery={searchQuery}
        worktreePath={worktreePath}
        activities={activities}
      />
    );
  };

  const renderStreamingTail = (position: number) => {
    if (
      position !== globalOffset + messages.length ||
      (!streamingThinkingNode && !streamingMessageNode)
    ) {
      return null;
    }
    return (
      <React.Fragment key={`streaming-tail-${position}`}>
        {streamingThinkingNode}
        {streamingMessageNode}
      </React.Fragment>
    );
  };

  return (
    <>
      {messages.map((msg, idx) => {
        // Sentinel dispatch for System messages — must precede the generic
        // message bubble so compaction/synthetic-summary messages render
        // as their own dedicated components.
        if (msg.role === "System") {
          const compaction = parseCompactionSentinel(msg.content);
          if (compaction) {
            return (
              <React.Fragment key={msg.id}>
                {renderTurns(globalOffset + idx)}
                {renderLiveToolActivity(globalOffset + idx)}
                <CompactionDivider
                  event={{
                    ...compaction,
                    timestamp: msg.created_at,
                    afterMessageIndex: globalOffset + idx,
                  }}
                />
              </React.Fragment>
            );
          }
          const syntheticBody = parseSyntheticSummarySentinel(msg.content);
          if (syntheticBody !== null) {
            return (
              <React.Fragment key={msg.id}>
                {renderTurns(globalOffset + idx)}
                {renderLiveToolActivity(globalOffset + idx)}
                <SyntheticContinuationMessage body={syntheticBody} />
              </React.Fragment>
            );
          }
        }
        // Default rendering for User, Assistant, and non-sentinel System messages.
        return (
          <React.Fragment key={msg.id}>
            {renderTurns(globalOffset + idx)}
            {renderLiveToolActivity(globalOffset + idx)}
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
                <ThinkingBlock
                  content={msg.thinking}
                  isStreaming={false}
                  inline={toolDisplayMode === "inline"}
                  searchQuery={searchQuery}
                />
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
            {renderPlainTurnFooter(idx + 1)}
          </React.Fragment>
        );
      })}
      {/* Turn activity groups that land after the last loaded message */}
      {renderTurns(globalOffset + messages.length)}
      {renderStreamingTail(globalOffset + messages.length)}
      {renderLiveToolActivity(globalOffset + messages.length)}
      {liveTaskProgressNode}
    </>
  );
});
