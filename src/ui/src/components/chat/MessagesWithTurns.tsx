import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import type { AgentConclusion, ChatMessage, ChatAttachment } from "../../types/chat";
import { collapsedToolGroupKey } from "./collapsedToolGroupKey";
import { CompactionDivider } from "./CompactionDivider";
import { SyntheticContinuationMessage } from "./SyntheticContinuationMessage";
import { SetupScriptBanner } from "./SetupScriptBanner";
import type { DownloadableAttachment } from "../../utils/attachmentDownload";
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
import { parseSetupScriptMessage } from "../../utils/setupScriptMessage";
import { deriveTaskProgressByTurn } from "../../hooks/useTaskTracker";
import { debugChat } from "../../utils/chatDebug";
import styles from "./ChatPanel.module.css";
import { CompletedTurnGroup } from "./CompletedTurnGroup";
import { ChatMessageBubble } from "./ChatMessageBubble";
import { buildTurnAssistantRouter } from "./turnAssistantRouting";
import { ToolActivityRow } from "./ToolActivityRow";
import { ToolActivitiesSection } from "./ToolActivitiesSection";
import { TurnFooter } from "./TurnFooter";
import { TurnEditSummaryCard } from "./EditChangeSummary";
import { summarizeTurnEdits } from "./editActivitySummary";
import {
  groupToolActivitiesForDisplay,
  type ToolActivityDisplayGroup,
} from "./toolActivityGroups";
import { isClaudeAuthError } from "../auth/claudeAuth";
import { monacoFileLinkTarget } from "./chatFileLinks";
import { tryOpenAgentFileTab } from "../../utils/agentFiles";
import { useWorkspaceFileIndex } from "./useWorkspaceFileIndex";
import {
  EMPTY_ACTIVITIES,
  EMPTY_ATTACHMENTS,
  EMPTY_CHECKPOINTS,
  EMPTY_COMPLETED_TURNS,
  EMPTY_CONCLUSIONS,
  type RollbackModalData,
} from "./chatConstants";
import { ConclusionCard } from "./ConclusionCard";

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
  onOpenFileLink,
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
  onOpenFileLink?: () => void;
}) {
  const completedTurns = useAppStore(
    (s) => s.completedTurns[sessionId] ?? EMPTY_COMPLETED_TURNS,
  );
  // Retained for the rare path where every group of a turn shares the
  // same id and a per-turn toggle is what we want; today's
  // chronological-split rendering uses the per-group setter below.
  const collapsedToolGroups = useAppStore(
    (s) => s.collapsedToolGroupsBySession[sessionId],
  );
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
  const chatConclusions = useAppStore(
    (s) => s.chatConclusions[sessionId] ?? EMPTY_CONCLUSIONS,
  );
  // Conclusions only render when the experimental "Claudette MCP" flag is on.
  // History load already skips fetching them when off, but a session that had
  // them loaded (flag toggled off mid-session) or a stray live event must also
  // stay dark — so we gate the render below, not just the fetch.
  const claudetteMcpEnabled = useAppStore((s) => s.claudetteMcpEnabled);
  const worktreePath = useAppStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.worktree_path,
  );
  const fileIndex = useWorkspaceFileIndex(workspaceId);
  const liveToolActivities = useAppStore(
    (s) => s.toolActivities[sessionId] ?? EMPTY_ACTIVITIES,
  );
  const resolvedClaudeAuthFailureMessageId = useAppStore(
    (s) => s.resolvedClaudeAuthFailureMessageId,
  );
  const lastAuthFailureMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (
        (msg.role === "Assistant" || msg.role === "System") &&
        isClaudeAuthError(msg.content)
      ) {
        return msg.id;
      }
    }
    return null;
  }, [messages]);

  // Pre-build a Map keyed by message_id for O(1) lookup in the render loop.
  //
  // Agent-origin attachments are persisted with `message_id` set to the *user*
  // message that triggered the turn (FK-cascade-safe). For display they
  // belong with the *assistant* message of the same turn — i.e. the next
  // Assistant message after the FK anchor in chronological order. This
  // re-route happens here so the storage shape can stay simple.
  const attachmentsByMessage = useMemo(() => {
    const route = buildTurnAssistantRouter(messages);
    const map = new Map<string, ChatAttachment[]>();
    for (const att of chatAttachments) {
      // Agent-origin attachments follow their turn's assistant message;
      // user-attached ones stay on the message they were sent with.
      const targetId =
        att.origin === "agent"
          ? (route(att.message_id) ?? att.message_id)
          : att.message_id;
      const list = map.get(targetId);
      if (list) list.push(att);
      else map.set(targetId, [att]);
    }
    return map;
  }, [chatAttachments, messages]);

  // Conclusions are agent-authored and anchored (like agent attachments) to the
  // *user* message that triggered the turn; re-route each to that turn's
  // *assistant* message so the card renders at the end of the turn. Mirrors the
  // attachment routing above (kept separate so its dependency set is just
  // conclusions + messages + the experimental flag gate).
  const conclusionsByMessage = useMemo(() => {
    if (!claudetteMcpEnabled || chatConclusions.length === 0)
      return new Map<string, AgentConclusion[]>();
    const route = buildTurnAssistantRouter(messages);
    const map = new Map<string, AgentConclusion[]>();
    for (const c of chatConclusions) {
      // A null anchor (no in-flight turn when presented) or one whose turn is
      // fully out of view routes to nothing and is skipped.
      const targetId = route(c.message_id);
      if (targetId === null) continue;
      const list = map.get(targetId);
      if (list) list.push(c);
      else map.set(targetId, [c]);
    }
    return map;
  }, [chatConclusions, messages, claudetteMcpEnabled]);

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
        kind: ToolActivityDisplayGroup["kind"];
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

      const activitiesByPosition = new Map<
        number,
        CompletedTurn["activities"]
      >();
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
        // The turn footer attaches to the last display group at the
        // turn's final position — unless that group is a skill marker.
        // Skills aren't tool calls; they render flat and flush, so the
        // footer falls through to the standalone path (below) and stays
        // at the bottom of the turn instead of landing above the marker.
        let finalGroupIndex = -1;
        if (position === turn.afterMessageIndex) {
          const last = displayGroups.length - 1;
          if (last >= 0 && displayGroups[last].kind !== "skill") {
            finalGroupIndex = last;
          }
        }
        hasFinalGroup ||= finalGroupIndex >= 0;
        displayGroups.forEach((group, groupIndex) => {
          (groupsByPosition[position] ??= []).push({
            turn,
            globalIdx,
            activities: group.activities,
            label: group.label,
            kind: group.kind,
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
  }, [
    completedTurns,
    findTriggeringUserIdx,
    globalOffset,
    messages,
    toolDisplayMode,
  ]);

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
  // The helper handles both `/` and `\` so this works on Windows
  // worktrees too. If the result still looks absolute or home-relative,
  // the file isn't reachable via the current worktree — bail rather than
  // passing a bad key into the file-tab store.
  const openFileInMonaco = useCallback(
    (filePath: string) => {
      // Agent-managed files (plans, memory) live outside the worktree —
      // route them to a read-only Monaco tab before worktree resolution.
      if (tryOpenAgentFileTab(workspaceId, filePath, openFileTab)) {
        onOpenFileLink?.();
        return true;
      }
      const target = monacoFileLinkTarget(filePath, worktreePath);
      if (!target) return false;
      onOpenFileLink?.();
      openFileTab(workspaceId, target.path, target.revealTarget);
      return true;
    },
    [onOpenFileLink, openFileTab, workspaceId, worktreePath],
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
  }, [
    checkpoints,
    localCompletedTurnPositions,
    messages,
    rollbackCheckpointByIdx,
  ]);

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

  // Cumulative task progress at each completed turn (single O(n) pass).
  const taskProgressByTurn = useMemo(
    () => deriveTaskProgressByTurn(completedTurns),
    [completedTurns],
  );

  useEffect(() => {
    debugChat("MessagesWithTurns", "layout", {
      workspaceId,
      sessionId,
      messageIds: messages.map((msg) => msg.id),
      turnLayout: completedTurns.map((turn) => ({
        id: turn.id,
        afterMessageIndex: turn.afterMessageIndex,
        postLastMessage:
          turn.afterMessageIndex >= globalOffset + messages.length,
        toolCount: turn.activities.length,
      })),
    });
  }, [workspaceId, sessionId, messages, completedTurns, globalOffset]);

  const renderTurns = (position: number) => {
    const groupEntries =
      chronologicalTurnLayout.groupsByPosition[position] ?? [];
    const footerEntries =
      chronologicalTurnLayout.finalFooterByPosition[position] ?? [];
    if (groupEntries.length === 0 && footerEntries.length === 0) return null;
    return (
      <>
        {groupEntries.map(
          ({ turn, globalIdx, activities, label, kind, showFooter }) => {
            // Skills aren't tool calls — render the flat "<skill> activated"
            // marker, never a collapsible TurnSummary. (`showFooter` is
            // always false for skill groups; see the layout builder.)
            if (kind === "skill" && activities[0]) {
              return (
                <ToolActivityRow
                  key={`${turn.id}:${position}:skill:${activities[0].toolUseId}`}
                  activity={activities[0]}
                  searchQuery={searchQuery}
                  worktreePath={worktreePath}
                  inline={toolDisplayMode === "inline"}
                />
              );
            }
            // A single turn can produce multiple display groups when
            // chronologically-interleaved messages split its activities;
            // each group has its own collapse state so clicking one chevron
            // doesn't drag every sibling group's expansion with it.
            //
            // The key intentionally drops `turn.id` and matches the live
            // `ToolActivitiesSection` key format (see `collapsedToolGroupKey`):
            // the same activity moves from `toolActivities[sessionId]` into
            // `completedTurns[sessionId][N].activities` when the turn ends with
            // its `toolUseId` preserved, so a choice made while running
            // survives the turn-end transition. Without an override,
            // `turn.collapsed` seeds the initial view of replayed turns.
            const groupKey =
              collapsedToolGroupKey(activities, kind) ??
              // Synthetic fallback for the (impossible-in-practice)
              // empty-activities case — keep keys session-unique without
              // accidentally colliding with a real tool group.
              `tools:__empty__:${turn.id}`;
            const isSingleGroupTurn =
              (chronologicalTurnLayout.groupsByPosition[position] ?? []).filter(
                (g) => g.globalIdx === globalIdx,
              ).length === 1;
            return (
              <CompletedTurnGroup
                key={`${turn.id}:${position}:${label}:${activities[0]?.toolUseId ?? "empty"}`}
                sessionId={sessionId}
                turn={turn}
                globalIdx={globalIdx}
                groupKey={groupKey}
                userOverride={collapsedToolGroups?.[groupKey]}
                isSingleGroupTurn={isSingleGroupTurn}
                activities={activities}
                label={label}
                kind={kind}
                showFooter={showFooter}
                toolDisplayMode={toolDisplayMode}
                searchQuery={searchQuery}
                worktreePath={worktreePath}
                taskProgress={taskProgressByTurn.get(globalIdx)}
                assistantText={assistantTextByTurnId.get(turn.id) ?? ""}
                rollbackData={isRunning ? undefined : rollbackByTurnId.get(turn.id)}
                onForkTurn={onForkTurn}
                onOpenEditFile={openFileInMonaco}
              />
            );
          },
        )}
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

  const pendingMessageInWindow = useMemo(
    () =>
      !!pendingMessageId && messages.some((msg) => msg.id === pendingMessageId),
    [messages, pendingMessageId],
  );

  const renderStreamingTail = (position: number) => {
    if (
      pendingMessageInWindow ||
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
        if (msg.role === "System" && msg.id !== pendingMessageId) {
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
          const setupOutcome = parseSetupScriptMessage(msg.content);
          if (setupOutcome) {
            return (
              <React.Fragment key={msg.id}>
                {renderTurns(globalOffset + idx)}
                {renderLiveToolActivity(globalOffset + idx)}
                <SetupScriptBanner outcome={setupOutcome} messageId={msg.id} />
              </React.Fragment>
            );
          }
        }

        // Default rendering for User, Assistant, and non-sentinel System messages.
        return (
          <React.Fragment key={msg.id}>
            {renderTurns(globalOffset + idx)}
            {renderLiveToolActivity(globalOffset + idx)}
            {msg.id === pendingMessageId ? (
              streamingMessageNode
            ) : (
              <ChatMessageBubble
                msg={msg}
                attachments={attachmentsByMessage.get(msg.id)}
                showThinkingBlocks={showThinkingBlocks}
                toolDisplayMode={toolDisplayMode}
                searchQuery={searchQuery}
                isLatestAuthFailure={msg.id === lastAuthFailureMessageId}
                isResolvedAuthFailure={msg.id === resolvedClaudeAuthFailureMessageId}
                resolveFilePath={fileIndex.resolve}
                openFile={openFileInMonaco}
                onAttachmentClick={onAttachmentClick}
                onAttachmentContextMenu={onAttachmentContextMenu}
              />
            )}
            {conclusionsByMessage.has(msg.id) &&
              conclusionsByMessage
                .get(msg.id)!
                .map((c) => (
                  <ConclusionCard
                    key={c.id}
                    conclusion={c}
                    workspaceId={workspaceId}
                  />
                ))}
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
