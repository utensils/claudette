import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import type { ChatMessage } from "../../../types/chat";
import type { CompletedTurn, ToolActivity } from "../../../stores/useAppStore";
import type { ToolDisplayMode } from "../../../stores/slices/settingsSlice";
import {
  deriveSessionMetrics,
  deriveTurnDashboard,
  groupMessagesIntoTurns,
  turnHasDashboardActivity,
  type TurnDashboardMetrics,
  type TurnGroup,
} from "./deriveDashboard";
import { SessionDashboardHeader } from "./SessionDashboardHeader";
import { TurnDashboardCard } from "./TurnDashboardCard";
import { HighlightedPlainText } from "../HighlightedPlainText";
import { HighlightedMessageMarkdown } from "../HighlightedMessageMarkdown";
import { MessageCopyButton } from "../MessageCopyButton";
import { roleClassKey } from "../messageRendering";
import { CompactionDivider } from "../CompactionDivider";
import { SyntheticContinuationMessage } from "../SyntheticContinuationMessage";
import { SetupScriptBanner } from "../SetupScriptBanner";
import {
  parseCompactionSentinel,
  parseSyntheticSummarySentinel,
} from "../../../utils/compactionSentinel";
import { parseSetupScriptMessage } from "../../../utils/setupScriptMessage";
import { EMPTY_ACTIVITIES, EMPTY_COMPLETED_TURNS } from "../chatConstants";
import cp from "../ChatPanel.module.css";

interface DashboardTurnView {
  group: TurnGroup;
  metrics: TurnDashboardMetrics;
  activities: ToolActivity[];
  thinkingContents: string[];
  showCard: boolean;
}

/**
 * Experimental "dashboard mode" transcript renderer. Drop-in alternative to
 * `MessagesWithTurns`, selected in `ChatPanelSessionView` when
 * `dashboardModeEnabled` is set.
 *
 * Per turn it shows the user's prompt, a live/finalized activity dashboard
 * card (counts of thoughts, tool calls, questions, plans, tasks…), and only
 * the turn's final assistant message — the intermediate narration, thinking,
 * and tool calls are collapsed into the card (expandable to the real detail).
 * A sticky session rollup sits on top.
 *
 * Plan reviews and questions are NOT handled here — they render in
 * `ChatPanelSessionView` outside the transcript, so both flows behave exactly
 * as in the default view.
 *
 * Spike simplifications (see PR): message attachments are not rendered, final
 * assistant file paths aren't click-to-open, and the session rollup covers
 * only loaded turns.
 */
export const DashboardChatView = memo(function DashboardChatView({
  messages,
  sessionId,
  isRunning,
  searchQuery,
  globalOffset = 0,
  toolDisplayMode,
  worktreePath,
}: {
  messages: ChatMessage[];
  workspaceId: string;
  sessionId: string;
  isRunning: boolean;
  searchQuery: string;
  globalOffset?: number;
  toolDisplayMode: ToolDisplayMode;
  worktreePath?: string | null;
}) {
  const { t } = useTranslation("chat");
  const completedTurns = useAppStore(
    (s) => s.completedTurns[sessionId] ?? EMPTY_COMPLETED_TURNS,
  );
  const liveActivities = useAppStore(
    (s) => s.toolActivities[sessionId] ?? EMPTY_ACTIVITIES,
  );
  const liveThinking = useAppStore((s) => s.streamingThinking[sessionId] ?? "");

  const globalIndexById = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((m, idx) => map.set(m.id, globalOffset + idx));
    return map;
  }, [messages, globalOffset]);

  const { turns, sessionMetrics, turnCount } = useMemo(() => {
    const groups = groupMessagesIntoTurns(messages);
    const completedByEnd = new Map<number, CompletedTurn>();
    for (const turn of completedTurns) {
      completedByEnd.set(turn.afterMessageIndex, turn);
    }

    const views: DashboardTurnView[] = groups.map((group, index) => {
      const globalEnd = globalOffset + group.endExclusive;
      const completedTurn = completedByEnd.get(globalEnd) ?? null;
      const isLiveTurn =
        isRunning && index === groups.length - 1 && !completedTurn;

      const activities = completedTurn
        ? completedTurn.activities
        : isLiveTurn
          ? [...liveActivities]
          : [];

      const thinkingContents: string[] = [];
      for (const m of group.assistantMessages) {
        if (m.thinking && m.thinking.trim().length > 0) {
          thinkingContents.push(m.thinking);
        }
      }
      for (const a of activities) {
        if (a.agentThinkingBlocks) thinkingContents.push(...a.agentThinkingBlocks);
      }
      if (isLiveTurn && liveThinking.trim().length > 0) {
        thinkingContents.push(liveThinking);
      }

      const metrics = deriveTurnDashboard({
        assistantMessages: group.assistantMessages,
        completedTurn,
        liveActivities: isLiveTurn ? liveActivities : undefined,
        liveThinking: isLiveTurn ? liveThinking : undefined,
        isLive: isLiveTurn,
      });

      return {
        group,
        metrics,
        activities,
        thinkingContents,
        showCard: turnHasDashboardActivity(metrics),
      };
    });

    return {
      turns: views,
      sessionMetrics: deriveSessionMetrics(
        views.map((v) => ({ metrics: v.metrics, activities: v.activities })),
      ),
      turnCount: groups.filter((g) => g.userMessage !== null).length,
    };
  }, [
    messages,
    completedTurns,
    liveActivities,
    liveThinking,
    isRunning,
    globalOffset,
  ]);

  return (
    <>
      {turnCount > 0 && (
        <SessionDashboardHeader metrics={sessionMetrics} turnCount={turnCount} />
      )}
      {turns.map(({ group, metrics, activities, thinkingContents, showCard }) => (
        <React.Fragment key={group.id}>
          {group.userMessage && (
            <div className={`${cp.message} ${cp.role_User}`}>
              <div className={cp.roleLabel}>{t("you_label")}</div>
              {group.userMessage.content.length > 0 && (
                <MessageCopyButton
                  text={group.userMessage.content}
                  className={cp.userMessageCopyButton}
                />
              )}
              <div className={cp.content}>
                <HighlightedPlainText
                  text={group.userMessage.content}
                  query={searchQuery}
                />
              </div>
            </div>
          )}

          {showCard && (
            <TurnDashboardCard
              metrics={metrics}
              sessionId={sessionId}
              toolDisplayMode={toolDisplayMode}
              searchQuery={searchQuery}
              worktreePath={worktreePath}
              activities={activities}
              thinkingContents={thinkingContents}
            />
          )}

          {group.finalAssistant && (
            <div className={`${cp.message} ${cp.role_Assistant}`}>
              <div className={cp.content}>
                <HighlightedMessageMarkdown
                  content={group.finalAssistant.content}
                  query={searchQuery}
                />
              </div>
            </div>
          )}

          {group.systemMessages.map((sys) => (
            <SystemMessageItem
              key={sys.id}
              message={sys}
              afterMessageIndex={globalIndexById.get(sys.id) ?? 0}
              searchQuery={searchQuery}
            />
          ))}
        </React.Fragment>
      ))}
    </>
  );
});

/** Passthrough renderer for System messages so dashboard mode keeps the
 *  compaction / synthetic-continuation / setup-script markers the default
 *  view shows. Mirrors the sentinel dispatch in `MessagesWithTurns`. */
const SystemMessageItem = memo(function SystemMessageItem({
  message,
  afterMessageIndex,
  searchQuery,
}: {
  message: ChatMessage;
  afterMessageIndex: number;
  searchQuery: string;
}) {
  const compaction = parseCompactionSentinel(message.content);
  if (compaction) {
    return (
      <CompactionDivider
        event={{ ...compaction, timestamp: message.created_at, afterMessageIndex }}
      />
    );
  }
  const syntheticBody = parseSyntheticSummarySentinel(message.content);
  if (syntheticBody !== null) {
    return <SyntheticContinuationMessage body={syntheticBody} />;
  }
  const setupOutcome = parseSetupScriptMessage(message.content);
  if (setupOutcome) {
    return <SetupScriptBanner outcome={setupOutcome} messageId={message.id} />;
  }
  return (
    <div className={`${cp.message} ${cp[roleClassKey("System", message.content)]}`}>
      <div className={cp.content}>
        <HighlightedMessageMarkdown content={message.content} query={searchQuery} />
      </div>
    </div>
  );
});
