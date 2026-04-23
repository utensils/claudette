import React, { createContext, memo, useContext, useEffect, useRef, useState, useMemo, useCallback } from "react";
import { isAgentBusy } from "../../utils/agentStatus";
import { HighlightedMessageMarkdown } from "./HighlightedMessageMarkdown";
import { HighlightedPlainText } from "./HighlightedPlainText";
import { ChatSearchBar } from "./ChatSearchBar";
import { AlertCircle, FileText, GitBranch, LoaderCircle, Mic, Plus, RotateCcw, Send, Split, Square, X } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolActivity, CompletedTurn } from "../../stores/useAppStore";
import {
  loadChatHistory,
  loadAttachmentsForSession,
  readFileAsBase64,
  listCheckpoints,
  loadCompletedTurns,
  listSlashCommands,
  openReleaseNotes,
  openUsageSettings,
  recordSlashCommandUsage,
  sendChatMessage,
  sendRemoteCommand,
  stopAgent,
  submitAgentAnswer,
  submitPlanApproval,
  getAppSetting,
  setAppSetting,
  listWorkspaceFiles,
  clearConversation,
  readPlanFile,
  loadDiffFiles,
  forkWorkspaceAtCheckpoint,
} from "../../services/tauri";
import { applySelectedModel } from "./applySelectedModel";
import { MODELS } from "./modelRegistry";
import { roleClassKey, shouldRenderAsMarkdown } from "./messageRendering";
import { StreamingContext } from "./StreamingContext";
import { findLatestPlanFilePath } from "./planFilePath";
import type { PermissionLevel } from "../../stores/useAppStore";
import { open } from "@tauri-apps/plugin-dialog";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { extractLatestCallUsage } from "../../utils/extractLatestCallUsage";
import type { SlashCommand, FileEntry } from "../../services/tauri";
import type { ChatMessage, ChatAttachment, AttachmentInput, PendingAttachment } from "../../types/chat";
import { base64ToBytes } from "../../utils/base64";
import {
  SUPPORTED_IMAGE_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS,
  maxSizeFor,
  isTextFile,
} from "../../utils/attachmentValidation";
import { useTypewriter } from "../../hooks/useTypewriter";
import { extractToolSummary } from "../../hooks/toolSummary";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { ComposerToolbar } from "./composer/ComposerToolbar";
import { SegmentedMeter } from "./composer/SegmentedMeter";
import { ContextPopover } from "./composer/ContextPopover";
import { WorkspaceActions } from "./WorkspaceActions";
import { SlashCommandPicker, filterSlashCommands } from "./SlashCommandPicker";
import { AttachMenu } from "./AttachMenu";
import {
  AttachmentContextMenu,
  buildAttachmentMenuLabels,
} from "./AttachmentContextMenu";
import { AttachmentLightbox } from "./AttachmentLightbox";
import {
  downloadAttachment,
  openAttachmentInBrowser,
  openAttachmentWithDefaultApp,
  copyAttachmentToClipboard,
  shareAttachment,
  isShareSupported,
  type DownloadableAttachment,
} from "../../utils/attachmentDownload";
import { FileMentionPicker, matchFiles } from "./FileMentionPicker";
import {
  describeSlashQuery,
  parseSlashInput,
  resolveNativeHandler,
} from "./nativeSlashCommands";
import { checkpointHasFileChanges, clearAllHasFileChanges, buildRollbackMap } from "../../utils/checkpointUtils";
import {
  assistantTextForTurn,
  buildPlainTurnFooters,
  findTriggeringUserIndex,
} from "../../utils/chatTurnFooter";
import { ThinkingBlock } from "./ThinkingBlock";
import { CompactionDivider } from "./CompactionDivider";
import { SyntheticContinuationMessage } from "./SyntheticContinuationMessage";
import {
  hasUltrathink,
  renderUltrathinkText,
  resolveUltrathinkEffort,
} from "./ultrathink";
import {
  extractCompactionEvents,
  parseCompactionSentinel,
  parseSyntheticSummarySentinel,
} from "../../utils/compactionSentinel";
import { PanelToggles } from "../shared/PanelToggles";
import { SessionTabs } from "./SessionTabs";
import { ChatToolbar } from "./ChatToolbar";
import { deriveTasks, processActivities, turnHasTaskActivity, hasTaskActivity } from "../../hooks/useTaskTracker";
import type { TaskTrackerResult, TrackedTask } from "../../hooks/useTaskTracker";
import { ScrollToBottomPill } from "./ScrollToBottomPill";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import { debugChat } from "../../utils/chatDebug";
import {
  insertTranscriptAtSelection,
  shouldOpenVoiceSettingsForError,
} from "../../utils/voice";
import styles from "./ChatPanel.module.css";
import caretStyles from "./caret.module.css";

import { formatTokens } from "./formatTokens";

function shouldDisable1mContext(modelId: string | null): boolean {
  if (!modelId) return false;
  const entry = MODELS.find((m) => m.id === modelId);
  return entry ? entry.contextWindowTokens < 1_000_000 : false;
}

/** Format a duration in seconds as "15s" or "2m 34s". */
function formatElapsedSeconds(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

/** Format a duration in milliseconds as "15s" or "2m 34s". Sub-second turns
 *  round up to "1s" so the footer always shows something meaningful. */
function formatDurationMs(ms: number): string {
  return formatElapsedSeconds(Math.max(1, Math.floor(ms / 1000)));
}

/**
 * Lazily renders a PDF first-page thumbnail.
 *
 * Accepts either `dataBase64` (optimistic/pre-loaded data) or `attachmentId`
 * (fetches the body from the backend on demand). Shows a loading pill with
 * the filename while the thumbnail generates.
 */
function PdfThumbnail({ dataBase64, attachmentId, filename, className, onClick, onContextMenu }: {
  dataBase64?: string;
  attachmentId?: string;
  filename: string;
  className?: string;
  /** Left-click handler. Used to open the PDF with the system's default
   *  PDF viewer rather than the lightbox (which only renders images). */
  onClick?: () => void;
  /** Right-click handler. Wired so PDF thumbnails get the same Claudette
   *  context menu (Download / Copy / Open) as image attachments rather than
   *  WebKit's default image menu. See issue 430. */
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;

    (async () => {
      let b64 = dataBase64;
      // If no inline data, fetch on demand from the backend.
      if (!b64 && attachmentId) {
        const { loadAttachmentData } = await import("../../services/tauri");
        b64 = await loadAttachmentData(attachmentId);
      }
      if (!b64 || cancelled) return;
      const bytes = base64ToBytes(b64);
      const { generatePdfThumbnail } = await import("../../utils/pdfThumbnail");
      const url = await generatePdfThumbnail(bytes.buffer as ArrayBuffer, 300, attachmentId);
      if (!cancelled) setSrc(url);
    })().catch(() => {});

    return () => { cancelled = true; };
  }, [dataBase64, attachmentId]);

  // Both the loading-state pill and the rendered first-page thumbnail
  // need to be keyboard-actionable when an onClick is wired — without
  // role/tabIndex/Enter+Space handling, non-mouse users can't open the
  // PDF.
  const interactiveProps = onClick
    ? {
        role: "button" as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        },
        "aria-label": `Open ${filename}`,
      }
    : {};
  if (!src) {
    return (
      <div
        className={styles.messagePdf}
        onClick={onClick}
        onContextMenu={onContextMenu}
        {...interactiveProps}
      >
        <FileText size={16} />
        <span>{filename}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={filename}
      className={className}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={onClick ? { cursor: "zoom-in" } : undefined}
      {...interactiveProps}
    />
  );
}

/** Semantic colors for tool names — makes tool activity scannable at a glance. */
const TOOL_COLORS: Record<string, string> = {
  Read: "var(--tool-read)",
  Glob: "var(--tool-read)",
  Grep: "var(--tool-read)",
  Write: "var(--tool-write)",
  Edit: "var(--tool-edit)",
  Bash: "var(--tool-bash)",
  WebSearch: "var(--tool-web)",
  WebFetch: "var(--tool-web)",
  Agent: "var(--tool-agent)",
  AskUserQuestion: "var(--accent-primary)",
};

function toolColor(name: string): string {
  return TOOL_COLORS[name] ?? "var(--text-muted)";
}

/** Context to pass sticky-scroll handler into streaming sub-components. */
const ScrollContext = createContext<{
  handleContentChanged: () => void;
}>({ handleContentChanged: () => {} });

// Stable empty arrays to avoid Zustand selector re-renders when data is undefined.
// Without these, `?? []` / `|| []` creates a new reference on every store update,
// causing Object.is to return false and triggering unnecessary component re-renders.
const EMPTY_COMPLETED_TURNS: CompletedTurn[] = [];
const EMPTY_ACTIVITIES: ToolActivity[] = [];
const EMPTY_ATTACHMENTS: ChatAttachment[] = [];

export function ChatPanel() {
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const activeSessionId = useAppStore((s) =>
    s.selectedWorkspaceId
      ? s.selectedSessionIdByWorkspaceId[s.selectedWorkspaceId] ?? null
      : null,
  );
  const workspaces = useAppStore((s) => s.workspaces);
  const repositories = useAppStore((s) => s.repositories);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const setChatMessages = useAppStore((s) => s.setChatMessages);
  const hydrateCompletedTurns = useAppStore((s) => s.hydrateCompletedTurns);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);
  const openPluginSettings = useAppStore((s) => s.openPluginSettings);
  const pluginManagementEnabled = useAppStore((s) => s.pluginManagementEnabled);
  const usageInsightsEnabled = useAppStore((s) => s.usageInsightsEnabled);
  const openSettings = useAppStore((s) => s.openSettings);
  const appVersion = useAppStore((s) => s.appVersion);
  const slashCommandsByWorkspace = useAppStore((s) => s.slashCommandsByWorkspace);
  const setSlashCommandsCache = useAppStore((s) => s.setSlashCommands);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Cmd/Ctrl+F search bar state. `searchQuery` flows down to message
  // renderers as the highlight trigger; an empty string short-circuits the
  // wrappers' DOM-walk pass entirely, so search-off has zero render cost.
  const chatSearchOpen = useAppStore(
    (s) => (selectedWorkspaceId ? s.chatSearch[selectedWorkspaceId]?.open ?? false : false),
  );
  const chatSearchQuery = useAppStore(
    (s) => (selectedWorkspaceId ? s.chatSearch[selectedWorkspaceId]?.query ?? "" : ""),
  );
  const searchQuery = chatSearchOpen ? chatSearchQuery : "";

  const [attachmentMenu, setAttachmentMenu] = useState<{
    x: number;
    y: number;
    attachment: DownloadableAttachment;
    /** Persisted PDFs hydrate without data_base64 (it's stripped to keep
     *  the initial IPC small). When the menu fires for one, hold the row
     *  id so each action can lazy-load the bytes via loadAttachmentData
     *  before downloading / copying. */
    attachmentId?: string;
  } | null>(null);

  const openAttachmentMenu = useCallback(
    (e: React.MouseEvent, attachment: DownloadableAttachment, attachmentId?: string) => {
      e.preventDefault();
      setAttachmentMenu({
        x: e.clientX,
        y: e.clientY,
        attachment,
        attachmentId,
      });
    },
    [],
  );

  /** Resolves an attachment's data_base64, fetching from the backend on
   *  demand if it was stripped during hydration. Returns a fresh object
   *  so callers can pass it straight into download / copy helpers. */
  const ensureAttachmentBytes = useCallback(
    async (
      attachment: DownloadableAttachment,
      attachmentId?: string,
    ): Promise<DownloadableAttachment> => {
      if (attachment.data_base64 || !attachmentId) return attachment;
      const { loadAttachmentData } = await import("../../services/tauri");
      const data_base64 = await loadAttachmentData(attachmentId);
      return { ...attachment, data_base64 };
    },
    [],
  );

  const [lightbox, setLightbox] = useState<{
    attachment: DownloadableAttachment;
    returnFocus: HTMLElement | null;
  } | null>(null);

  const openLightbox = useCallback(
    (e: React.MouseEvent, attachment: DownloadableAttachment) => {
      setLightbox({
        attachment,
        returnFocus: (e.currentTarget as HTMLElement) ?? null,
      });
    },
    [],
  );

  // navigator.canShare({ files: [probe] }) doesn't change across re-renders —
  // it's a function of the platform / webview capabilities. Compute once.
  const shareSupported = useMemo(() => isShareSupported(), []);

  // Prompt history: stores past user inputs per session.
  const historyRef = useRef<Record<string, string[]>>({});
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  const defaultBranchesMap = useAppStore((s) => s.defaultBranches);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const defaultBranch = repo ? defaultBranchesMap[repo.id] : undefined;
  const messages = activeSessionId
    ? chatMessages[activeSessionId] || []
    : [];
  // Subscribe only to boolean — avoids re-render on every streaming character
  const hasStreaming = useAppStore(
    (s) => !!(activeSessionId && s.streamingContent[activeSessionId])
  );
  const hasPendingTypewriter = useAppStore(
    (s) => !!(activeSessionId && s.pendingTypewriter[activeSessionId])
  );
  const hasThinking = useAppStore(
    (s) => !!(activeSessionId && s.streamingThinking[activeSessionId])
  );
  const showThinkingBlocks = useAppStore(
    (s) => activeSessionId ? s.showThinkingBlocks[activeSessionId] === true : false
  );
  // Subscribe only to count — avoids re-render on tool activity content changes
  const activitiesCount = useAppStore(
    (s) => (activeSessionId ? (s.toolActivities[activeSessionId] || []).length : 0)
  );
  const completedTurnsCount = useAppStore(
    (s) => (activeSessionId ? (s.completedTurns[activeSessionId] || []).length : 0)
  );
  const permissionLevelMap = useAppStore((s) => s.permissionLevel);
  const setPermissionLevel = useAppStore((s) => s.setPermissionLevel);
  const permissionLevel = activeSessionId
    ? permissionLevelMap[activeSessionId] ?? "full"
    : "full";
  const pendingQuestion = useAppStore(
    (s) => (activeSessionId ? s.agentQuestions[activeSessionId] ?? null : null)
  );
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const finishTypewriterDrainTop = useAppStore((s) => s.finishTypewriterDrain);
  const pendingPlan = useAppStore(
    (s) => (activeSessionId ? s.planApprovals[activeSessionId] ?? null : null)
  );
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const queuedMessage = useAppStore(
    (s) => (activeSessionId ? s.queuedMessages[activeSessionId] ?? null : null)
  );
  const setQueuedMessage = useAppStore((s) => s.setQueuedMessage);
  const clearQueuedMessage = useAppStore((s) => s.clearQueuedMessage);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const activeSessionStatus = useAppStore((s) => {
    if (!activeSessionId || !selectedWorkspaceId) return "Idle" as const;
    const sessions = s.sessionsByWorkspace[selectedWorkspaceId];
    return sessions?.find((sess) => sess.id === activeSessionId)?.agent_status ?? "Idle" as const;
  });
  const isRunning = activeSessionStatus === "Running";

  const isRemote = !!ws?.remote_connection_id;

  const handleFork = useCallback(
    async (checkpointId: string) => {
      if (!selectedWorkspaceId || isRemote) return;
      try {
        const result = await forkWorkspaceAtCheckpoint(
          selectedWorkspaceId,
          checkpointId,
        );
        addWorkspace(result.workspace);
        selectWorkspace(result.workspace.id);
      } catch (err) {
        setError(`Failed to fork workspace: ${err}`);
      }
    },
    [selectedWorkspaceId, isRemote, addWorkspace, selectWorkspace],
  );

  // Sticky scroll: auto-follow when at bottom, stop when user scrolls up.
  const { isAtBottom, scrollToBottom, handleContentChanged } =
    useStickyScroll(messagesContainerRef);

  // Memoize context value to avoid re-rendering StreamingMessage on every parent render.
  const scrollContextValue = useMemo(
    () => ({ handleContentChanged }),
    [handleContentChanged],
  );

  // Elapsed timer for running agent.
  const promptStartTime = useAppStore(
    (s) => (selectedWorkspaceId ? s.promptStartTime[selectedWorkspaceId] ?? null : null)
  );
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!isRunning || promptStartTime == null) return;
    setElapsed(Math.floor((Date.now() - promptStartTime) / 1000));
    const interval = setInterval(() => {
      const newElapsed = Math.floor((Date.now() - promptStartTime) / 1000);
      setElapsed((prev) => (prev === newElapsed ? prev : newElapsed));
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning, promptStartTime]);

  const formatElapsed = formatElapsedSeconds;

  // Load persisted permission level when the active session changes.
  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    getAppSetting(`permission_level:${activeSessionId}`)
      .then((val) => {
        if (cancelled) return;
        if (val === "readonly" || val === "standard" || val === "full") {
          setPermissionLevel(activeSessionId, val);
        }
      })
      .catch((err) => {
        console.error("Failed to load permission level:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId, setPermissionLevel]);

  // Load chat history when the active session changes, seed prompt history from it.
  useEffect(() => {
    if (!activeSessionId || !selectedWorkspaceId) return;
    let cancelled = false;
    setError(null);
    historyIndexRef.current = -1;
    draftRef.current = "";

    const currentWs = useAppStore
      .getState()
      .workspaces.find((w) => w.id === selectedWorkspaceId);
    const sessionId = activeSessionId;
    const loadHistory = currentWs?.remote_connection_id
      ? sendRemoteCommand(currentWs.remote_connection_id, "load_chat_history", {
          session_id: sessionId,
        }).then((data) => (data as { messages?: ChatMessage[] })?.messages ?? data as ChatMessage[])
      : loadChatHistory(sessionId);

    const isLocal = !currentWs?.remote_connection_id;

    debugChat("ChatPanel", "load-history:start", {
      sessionId,
      isLocal,
      agentStatus: currentWs?.agent_status ?? null,
    });

    loadHistory
      .then((msgs: ChatMessage[]) => {
        if (cancelled) return;
        // Filter out empty assistant messages (legacy data), but keep
        // those that carry thinking content.
        const filtered = msgs.filter(
          (m) => m.role !== "Assistant" || m.content.trim() !== "" || !!m.thinking
        );
        debugChat("ChatPanel", "load-history:success", {
          sessionId,
          rawMessageCount: msgs.length,
          filteredMessageCount: filtered.length,
          messageIds: filtered.map((msg) => msg.id),
        });
        setChatMessages(sessionId, filtered);
        historyRef.current[sessionId] = filtered
          .filter((m) => m.role === "User")
          .map((m) => m.content);
        // Seed the ContextMeter from the last assistant message's per-call
        // token data. If none is available (fresh / pre-migration workspace),
        // clear any stale value so the meter hides.
        const callUsage = extractLatestCallUsage(filtered);
        const store = useAppStore.getState();
        if (callUsage) store.setLatestTurnUsage(selectedWorkspaceId, callUsage);
        else store.clearLatestTurnUsage(selectedWorkspaceId);
        // Phase 3: seed compactionEvents by scanning for COMPACTION: sentinels.
        store.setCompactionEvents(selectedWorkspaceId, extractCompactionEvents(filtered));

        // Load attachments for this session's messages.
        if (isLocal) {
          loadAttachmentsForSession(sessionId)
            .then((atts) => {
              if (cancelled) return;
              useAppStore.getState().setChatAttachments(sessionId, atts);
            })
            .catch((e) => console.error("Failed to load attachments:", e));
        }

        // Load persisted completed turns and reconstruct with correct positions.
        // Skip if the agent is currently running — the in-memory state from
        // finalizeTurn() is more current than the DB and must not be overwritten.
        if (isLocal) {
          const ws = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId);
          const isRunning = isAgentBusy(ws?.agent_status);
          debugChat("ChatPanel", "load-completed-turns:gate", {
            sessionId,
            isRunning,
            currentCompletedTurnIds: (useAppStore.getState().completedTurns[sessionId] || []).map(
              (turn) => turn.id
            ),
          });
          if (!isRunning) {
            loadCompletedTurns(sessionId)
              .then((turnData) => {
                if (cancelled) return;
                const turns = reconstructCompletedTurns(filtered, turnData);
                debugChat("ChatPanel", "load-completed-turns:success", {
                  sessionId,
                  dbTurnIds: turnData.map((turn) => turn.checkpoint_id),
                  reconstructedTurnIds: turns.map((turn) => turn.id),
                });
                hydrateCompletedTurns(sessionId, turns);
              })
              .catch((e) => console.error("Failed to load completed turns:", e));
          }
        }
      })
      .catch((e) => console.error("Failed to load chat history:", e));

    // Load checkpoints for rollback support.
    if (isLocal) {
      const setCheckpoints = useAppStore.getState().setCheckpoints;
      listCheckpoints(sessionId)
        .then((cps) => {
          if (cancelled) return;
          setCheckpoints(sessionId, cps);
        })
        .catch((e) => console.error("Failed to load checkpoints:", e));
    }

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, selectedWorkspaceId, setChatMessages, hydrateCompletedTurns]);

  // Scroll to bottom unconditionally on session switch.
  useEffect(() => {
    if (activeSessionId) scrollToBottom();
  }, [activeSessionId, scrollToBottom]);

  // Auto-scroll when new content arrives — respects user intent via useStickyScroll.
  // Only scrolls if the user is already at/near the bottom.
  const prevMsgCountRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const sid = activeSessionId;
    if (!sid) return;
    const prev = prevMsgCountRef.current[sid] ?? 0;
    const cur = messages.length;
    prevMsgCountRef.current[sid] = cur;
    // Only trigger on genuinely new messages (count increase), not DB rehydration.
    if (cur > prev) handleContentChanged();
  }, [messages.length, activeSessionId, handleContentChanged]);

  useEffect(() => {
    if (completedTurnsCount > 0 || activitiesCount > 0 || pendingQuestion || pendingPlan) {
      handleContentChanged();
    }
  }, [completedTurnsCount, activitiesCount, pendingQuestion, pendingPlan, handleContentChanged]);

  useEffect(() => {
    if (!activeSessionId) return;
    debugChat("ChatPanel", "state", {
      sessionId: activeSessionId,
      wsId: selectedWorkspaceId,
      isRunning,
      messageCount: messages.length,
      activitiesCount,
      completedTurnsCount,
      hasStreaming,
    });
  }, [
    activeSessionId,
    selectedWorkspaceId,
    isRunning,
    messages.length,
    activitiesCount,
    completedTurnsCount,
    hasStreaming,
  ]);

  // Auto-dispatch queued message when agent becomes idle.
  const handleSendRef = useRef<((
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => void) | null>(null);
  useEffect(() => {
    if (isRunning || !activeSessionId || !queuedMessage) return;
    // Agent just finished — dispatch the queued message.
    const { content, mentionedFiles, attachments } = queuedMessage;
    clearQueuedMessage(activeSessionId);
    const filesSet = mentionedFiles?.length ? new Set(mentionedFiles) : undefined;
    // Use a microtask to avoid calling handleSend during render.
    queueMicrotask(() => handleSendRef.current?.(content, filesSet, attachments));
  }, [isRunning, activeSessionId, queuedMessage, clearQueuedMessage]);

  if (!ws) return null;

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
          addChatMessage(sessionId, {
            id: crypto.randomUUID(),
            workspace_id: workspaceId,
            session_id: sessionId,
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
          });
        };

        const setSelectedModelBound = (nextModel: string) =>
          applySelectedModel(sessionId, nextModel);

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
            pluginManagementEnabled,
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

    // Clear any pending agent question or plan approval — the user is sending
    // a new message (answer from a card or manual override). Also release any
    // stuck typewriter drain from the previous turn so the completed message
    // doesn't stay hidden behind pendingTypewriter across turns (the
    // drain-complete effect cannot fire while isStreaming flips back to true).
    clearAgentQuestion(sessionId);
    clearPlanApproval(sessionId);
    finishTypewriterDrainTop(sessionId);

    setError(null);

    // Push to prompt history.
    const history = (historyRef.current[sessionId] ??= []);
    history.push(trimmed);
    historyIndexRef.current = -1;
    draftRef.current = "";
    const optimisticMsgId = crypto.randomUUID();
    addChatMessage(sessionId, {
      id: optimisticMsgId,
      workspace_id: selectedWorkspaceId,
      session_id: sessionId,
      role: "User",
      content: trimmed,
      cost_usd: null,
      duration_ms: null,
      created_at: new Date().toISOString(),
      thinking: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    });
    // Add optimistic attachment data so images display immediately.
    if (attachments?.length) {
      const optimisticAtts = attachments.map((a) => ({
        id: crypto.randomUUID(),
        message_id: optimisticMsgId,
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
    // Keep both the workspace aggregate AND the per-session status fresh.
    // The tab icon, sidebar badge, and ChatToolbar disable-state all read
    // session-level status; the workspace row still drives tray + unread.
    updateWorkspace(selectedWorkspaceId, { agent_status: "Running" });
    useAppStore.getState().setPromptStartTime(selectedWorkspaceId, Date.now());
    useAppStore.getState().updateChatSession(sessionId, {
      agent_status: "Running",
    });
    useAppStore.getState().clearUnreadCompletion(selectedWorkspaceId);

    try {
      if (ws?.remote_connection_id) {
        // Route to remote server via WebSocket.
        const state = useAppStore.getState();
        const selectedModel = state.selectedModel[sessionId] || null;
        const disable1mContext = shouldDisable1mContext(selectedModel);
        await sendRemoteCommand(ws.remote_connection_id, "send_chat_message", {
          session_id: sessionId,
          content: trimmed,
          mentioned_files: mentionedFilesArray,
          permission_level: permissionLevel,
          model: state.selectedModel[sessionId] || null,
          fast_mode: state.fastMode[sessionId] || false,
          thinking_enabled: state.thinkingEnabled[sessionId] || false,
          plan_mode: state.planMode[sessionId] || false,
          effort: state.effortLevel[sessionId] || null,
          chrome_enabled: state.chromeEnabled[sessionId] || false,
          disable_1m_context: disable1mContext,
        });
      } else {
        const state = useAppStore.getState();
        const model = state.selectedModel[sessionId] || undefined;
        const fastMode = state.fastMode[sessionId] || false;
        const thinkingEnabled = state.thinkingEnabled[sessionId] || false;
        const planMode = state.planMode[sessionId] || false;
        const effort = resolveUltrathinkEffort(
          trimmed,
          state.effortLevel[sessionId],
        );
        const chromeEnabled = state.chromeEnabled[sessionId] || false;
        const disable1mContext = shouldDisable1mContext(model ?? null);
        await sendChatMessage(
          sessionId,
          trimmed,
          mentionedFilesArray,
          permissionLevel,
          model,
          fastMode || undefined,
          thinkingEnabled || undefined,
          planMode || undefined,
          effort,
          chromeEnabled || undefined,
          disable1mContext || undefined,
          attachments,
          optimisticMsgId,
        );
      }
    } catch (e) {
      const errMsg = String(e);
      console.error("sendChatMessage failed:", errMsg);
      setError(errMsg);
      updateWorkspace(selectedWorkspaceId, { agent_status: "Idle" });
      useAppStore.getState().clearPromptStartTime(selectedWorkspaceId);
    }
  };

  handleSendRef.current = handleSend;

  const handleStop = async () => {
    if (!activeSessionId || !selectedWorkspaceId) return;
    const sessionId = activeSessionId;
    // Clear queued message — stopping means the user wants to take control.
    clearQueuedMessage(sessionId);
    try {
      if (ws?.remote_connection_id) {
        await sendRemoteCommand(ws.remote_connection_id, "stop_agent", {
          session_id: sessionId,
        });
      } else {
        await stopAgent(sessionId);
      }
      updateWorkspace(selectedWorkspaceId, { agent_status: "Stopped" });
    } catch (e) {
      console.error("stopAgent failed:", e);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header} data-tauri-drag-region>
        <div className={styles.headerLeft}>
          {repo ? (
            <span className={styles.branchInfo}>
              <span className={styles.repoName}>{repo.name}</span>
              <span className={styles.branchSep}>/</span>
              <GitBranch size={12} className={styles.branchIcon} />
              <span className={styles.branchName}>{ws.branch_name}</span>
              {defaultBranch && (
                <>
                  <span className={styles.branchArrow}>{'>'}</span>
                  <span className={styles.baseBranch}>{defaultBranch.replace(/^origin\//, '')}</span>
                </>
              )}
            </span>
          ) : (
            <span className={styles.repoName}>{ws.name}</span>
          )}
        </div>
        <div className={styles.headerRight}>
          <WorkspaceActions
            worktreePath={ws.worktree_path}
          />
          <PanelToggles />
        </div>
      </div>
      {selectedWorkspaceId && <SessionTabs workspaceId={selectedWorkspaceId} />}

      <div className={styles.messagesWrapper}>
        {selectedWorkspaceId && (
          <ChatSearchBar
            workspaceId={selectedWorkspaceId}
            scopeRef={messagesContainerRef}
          />
        )}
        <ScrollContext.Provider value={scrollContextValue}>
        <div className={styles.messages} ref={messagesContainerRef}>
          {messages.length === 0 && !hasStreaming ? (
            <div className={styles.empty}>
              Send a message to start a conversation
            </div>
          ) : (
            <>
              {activeSessionId && selectedWorkspaceId && (
                <MessagesWithTurns
                  messages={messages}
                  workspaceId={selectedWorkspaceId}
                  sessionId={activeSessionId}
                  isRunning={isRunning}
                  onForkTurn={isRemote ? undefined : handleFork}
                  onAttachmentContextMenu={openAttachmentMenu}
                  onAttachmentClick={openLightbox}
                  searchQuery={searchQuery}
                />
              )}

              {activeSessionId && hasThinking && showThinkingBlocks && (
                <StreamingThinkingBlock
                  workspaceId={activeSessionId}
                  isStreaming={isRunning ?? false}
                  searchQuery={searchQuery}
                />
              )}

              {activeSessionId && (hasStreaming || hasPendingTypewriter) && (
                <StreamingMessage workspaceId={activeSessionId} isStreaming={isRunning ?? false} searchQuery={searchQuery} />
              )}

              {activeSessionId && activitiesCount > 0 && (
                <ToolActivitiesSection
                  workspaceId={activeSessionId}
                  isRunning={isRunning ?? false}
                  searchQuery={searchQuery}
                />
              )}

              {activeSessionId && (
                <CurrentTurnTaskProgress workspaceId={activeSessionId} />
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

              {pendingPlan && (
                <PlanApprovalCard
                  approval={pendingPlan}
                  remoteConnectionId={ws?.remote_connection_id ?? undefined}
                  onRespond={async (approved, reason) => {
                    if (!activeSessionId) return;
                    const sid = activeSessionId;
                    const toolUseId = pendingPlan.toolUseId;
                    try {
                      await submitPlanApproval(sid, toolUseId, approved, reason);
                      clearPlanApproval(sid);
                      // User action is authoritative for ending the plan
                      // phase — flip planMode off so the next turn triggers
                      // drift detection (backend `session_exited_plan` covers
                      // this already, but clearing the UI state keeps the
                      // toolbar chip in sync).
                      setPlanMode(sid, false);
                    } catch (e) {
                      console.error("Failed to submit plan approval:", e);
                      setError(String(e));
                    }
                  }}
                />
              )}

              {isRunning && !pendingQuestion && !pendingPlan && (
                <div
                  ref={processingRef}
                  className={styles.processing}
                  role="status"
                  aria-label={
                    ws?.agent_status === "Compacting"
                      ? `Compacting context, ${formatElapsed(elapsed)} elapsed`
                      : `Processing, ${formatElapsed(elapsed)} elapsed`
                  }
                >
                  <LoaderCircle size={14} className={styles.spinner} aria-hidden="true" />
                  {ws?.agent_status === "Compacting" && (
                    <span className={styles.compactingLabel}>Compacting context…</span>
                  )}
                  <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
                </div>
              )}

              {queuedMessage && activeSessionId && (
                <div className={styles.queuedMessage}>
                  <span className={styles.queuedLabel}>Queued</span>
                  <span className={styles.queuedContent}>{queuedMessage.content}</span>
                  <button
                    className={styles.queuedCancel}
                    onClick={() => clearQueuedMessage(activeSessionId)}
                    title="Cancel queued message"
                  >
                    ×
                  </button>
                </div>
              )}

              {error && <div className={styles.errorBanner}>{error}</div>}
            </>
          )}
        </div>
      </ScrollContext.Provider>
      </div>

      <ScrollToBottomPill
        visible={!isAtBottom && messages.length > 0}
        onClick={scrollToBottom}
      />

      <ChatInputArea
        onSend={handleSend}
        onStop={handleStop}
        isRunning={isRunning}
        isRemote={!!ws?.remote_connection_id}
        selectedWorkspaceId={selectedWorkspaceId!}
        sessionId={activeSessionId!}
        repoId={repo?.id}
        projectPath={repo?.path}
        historyRef={historyRef}
        historyIndexRef={historyIndexRef}
        draftRef={draftRef}
        onAttachmentContextMenu={openAttachmentMenu}
        onAttachmentClick={openLightbox}
      />
      {attachmentMenu && (() => {
        const mt = attachmentMenu.attachment.media_type;
        const labels = buildAttachmentMenuLabels(mt);
        // The browser-wrapper path renders bytes inside <img>, which is
        // broken for PDFs (and would be broken for any non-image type we
        // add later). Drop "Open in New Window" for non-images — left-
        // click already opens the PDF in the system default viewer.
        const isImage = mt.startsWith("image/");
        const withBytes = () =>
          ensureAttachmentBytes(
            attachmentMenu.attachment,
            attachmentMenu.attachmentId,
          );
        return (
          <AttachmentContextMenu
            x={attachmentMenu.x}
            y={attachmentMenu.y}
            onClose={() => setAttachmentMenu(null)}
            items={[
              {
                label: labels.download,
                onSelect: () => {
                  withBytes()
                    .then(downloadAttachment)
                    .catch((err) => console.error("Download failed:", err));
                },
              },
              {
                label: labels.copy,
                onSelect: () => {
                  withBytes()
                    .then(copyAttachmentToClipboard)
                    .catch((err) => console.error("Copy failed:", err));
                },
              },
              ...(isImage
                ? [
                    {
                      label: labels.open,
                      onSelect: () => {
                        withBytes()
                          .then(openAttachmentInBrowser)
                          .catch((err) =>
                            console.error("Open in browser failed:", err),
                          );
                      },
                    },
                  ]
                : []),
              ...(shareSupported
                ? [
                    {
                      label: "Share…",
                      onSelect: () => {
                        withBytes()
                          .then(shareAttachment)
                          .catch((err) => console.error("Share failed:", err));
                      },
                    },
                  ]
                : []),
            ]}
          />
        );
      })()}
      {lightbox && (
        <AttachmentLightbox
          attachment={lightbox.attachment}
          returnFocusTo={lightbox.returnFocus}
          onClose={() => setLightbox(null)}
          onContextMenu={(e) => openAttachmentMenu(e, lightbox.attachment)}
        />
      )}
    </div>
  );
}

/**
 * Isolated thinking block — subscribes to streamingThinking to avoid
 * re-rendering ChatPanel on every thinking delta.
 */
const StreamingThinkingBlock = memo(function StreamingThinkingBlock({
  workspaceId,
  isStreaming,
  searchQuery,
}: {
  workspaceId: string;
  isStreaming: boolean;
  searchQuery: string;
}) {
  const thinking = useAppStore(
    (s) => s.streamingThinking[workspaceId] || ""
  );
  if (!thinking) return null;
  return (
    <ThinkingBlock
      content={thinking}
      isStreaming={isStreaming}
      enableTypewriter
      searchQuery={searchQuery}
    />
  );
});

/**
 * Isolated streaming message component — runs the typewriter reveal at a steady
 * rate while the agent streams, and keeps draining the latched text after
 * streamingContent clears so the transition to the completed message is smooth
 * (the just-added chat message is hidden behind pendingTypewriter until drain
 * completes).
 */
const StreamingMessage = memo(function StreamingMessage({
  workspaceId,
  isStreaming,
  searchQuery,
}: {
  workspaceId: string;
  isStreaming: boolean;
  searchQuery: string;
}) {
  const streaming = useAppStore(
    (s) => s.streamingContent[workspaceId] || ""
  );
  const pendingText = useAppStore(
    (s) => s.pendingTypewriter[workspaceId]?.text ?? ""
  );
  const finishTypewriterDrain = useAppStore((s) => s.finishTypewriterDrain);
  const { handleContentChanged } = useContext(ScrollContext);

  const fullText = streaming || pendingText;
  const { displayed, showCaret } = useTypewriter(fullText, isStreaming);

  useEffect(() => {
    handleContentChanged();
  }, [displayed, handleContentChanged]);

  // Drain complete + we're in pending-typewriter phase → release the hidden
  // completed message so it takes over visually without a jump. Also clears
  // streamingThinking in the same store update so StreamingThinkingBlock
  // unmounts atomically with the completed message unhiding.
  useEffect(() => {
    if (!showCaret && !streaming && pendingText) {
      finishTypewriterDrain(workspaceId);
    }
  }, [showCaret, streaming, pendingText, workspaceId, finishTypewriterDrain]);

  if (!displayed) return null;

  return (
    <div
      className={`${styles.message} ${styles.role_Assistant}`}
      aria-live="polite"
      aria-busy={isStreaming}
    >
      <div className={styles.content}>
        <StreamingContext.Provider value={isStreaming || pendingText.length > 0}>
          <HighlightedMessageMarkdown content={displayed} query={searchQuery} />
        </StreamingContext.Provider>
        {showCaret && <span className={caretStyles.caret} aria-hidden="true" />}
      </div>
    </div>
  );
});

/**
 * Render a single completed turn summary (collapsible tool call list).
 */
function TurnSummary({
  turn,
  collapsed,
  onToggle,
  taskProgress,
  assistantText,
  onFork,
  onRollback,
  searchQuery,
}: {
  turn: CompletedTurn;
  collapsed: boolean;
  onToggle: () => void;
  taskProgress?: TaskTrackerResult;
  /** Joined text from assistant messages in this turn, used by copy action.
   *  When empty, the copy button is not rendered. */
  assistantText: string;
  /** Called when the user clicks fork. When undefined the fork button is not
   *  rendered (e.g. remote workspaces, where the fork command cannot run). */
  onFork?: () => void;
  /** Called when the user clicks rollback. Undefined hides the button
   *  (e.g. turn is running, or no checkpoint exists for this turn). */
  onRollback?: () => void;
  /** Active chat-search query. Force-expands this card when non-empty and
   *  the query matches inside any of the contained activity summaries. */
  searchQuery: string;
}) {
  const hasElapsed = typeof turn.durationMs === "number" && turn.durationMs > 0;
  const hasTokens =
    typeof turn.inputTokens === "number" && typeof turn.outputTokens === "number";
  const hasCopy = assistantText.length > 0;
  const hasFork = !!onFork;
  const hasRollback = !!onRollback;
  const showFooter = hasElapsed || hasTokens || hasCopy || hasFork || hasRollback;

  // Force-expand if the query matches in any activity summary or the
  // resolved tool-summary fallback. Without this, marks would land in
  // detached DOM (the collapsed branch never renders), so the bar's
  // counter would tick up but nothing visible would change.
  const queryHasMatch =
    !!searchQuery &&
    turn.activities.some((a) => {
      const text = a.summary || extractToolSummary(a.toolName, a.inputJson);
      return text.toLowerCase().includes(searchQuery.toLowerCase());
    });
  const isExpanded = !collapsed || queryHasMatch;

  return (
    <div className={styles.turnSummaryWrapper}>
      <div
        className={styles.turnSummary}
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className={styles.turnHeader}>
          <span className={styles.toolChevron}>
            {isExpanded ? "⌄" : "›"}
          </span>
          <span className={styles.turnLabel}>
            {turn.activities.length} tool call
            {turn.activities.length !== 1 ? "s" : ""}
            {turn.messageCount > 0 &&
              `, ${turn.messageCount} message${turn.messageCount !== 1 ? "s" : ""}`}
          </span>
        </div>
        {isExpanded && (
          <div className={styles.turnActivities}>
            {turn.activities.map((act: ToolActivity) => (
              <div key={act.toolUseId} className={styles.toolActivity}>
                <div className={styles.toolHeader}>
                  <span className={styles.toolName} style={{ color: toolColor(act.toolName) }}>
                    {act.toolName}
                  </span>
                  {(act.summary || act.inputJson) && (
                    <span className={styles.toolSummary}>
                      <HighlightedPlainText
                        text={act.summary || extractToolSummary(act.toolName, act.inputJson)}
                        query={searchQuery}
                      />
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {taskProgress && taskProgress.totalCount > 0 && (
        <TaskProgressBar
          completedCount={taskProgress.completedCount}
          totalCount={taskProgress.totalCount}
        />
      )}
      {showFooter && (
        <TurnFooter
          durationMs={turn.durationMs}
          inputTokens={turn.inputTokens}
          outputTokens={turn.outputTokens}
          assistantText={hasCopy ? assistantText : undefined}
          onFork={onFork}
          onRollback={onRollback}
        />
      )}
    </div>
  );
}

/** Bottom-of-turn action row: elapsed time, copy output, fork, rollback.
 *  Rendered below the turn summary for every completed turn. */
function TurnFooter({
  durationMs,
  inputTokens,
  outputTokens,
  assistantText,
  onFork,
  onRollback,
  className,
}: {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  assistantText?: string;
  onFork?: () => void;
  onRollback?: () => void;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!assistantText) return;
    navigator.clipboard
      .writeText(assistantText)
      .then(() => {
        setCopied(true);
        if (copyTimeoutRef.current !== null) {
          window.clearTimeout(copyTimeoutRef.current);
        }
        copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch((err) => {
        console.error("Copy to clipboard failed:", err);
      });
  };

  const handleFork = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFork?.();
  };

  const handleRollback = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRollback?.();
  };

  const tokensNode =
    typeof inputTokens === "number" && typeof outputTokens === "number" ? (
      <span key="tokens" className={styles.turnFooterTokens}>
        {formatTokens(inputTokens)} in · {formatTokens(outputTokens)} out
      </span>
    ) : null;

  const elapsedNode =
    typeof durationMs === "number" && durationMs > 0 ? (
      <span key="elapsed" className={styles.turnFooterElapsed}>
        {formatDurationMs(durationMs)}
      </span>
    ) : null;

  const actionButtons: React.ReactNode[] = [];
  if (assistantText) {
    actionButtons.push(
      <button
        key="copy"
        type="button"
        className={styles.turnFooterButton}
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy output"}
        aria-label="Copy agent output"
      >
        {copied ? (
          // Checkmark feedback for ~1.2s after successful copy.
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        )}
      </button>,
    );
  }
  if (onFork) {
    actionButtons.push(
      <button
        key="fork"
        type="button"
        className={styles.turnFooterButton}
        onClick={handleFork}
        title="Fork workspace at this turn"
        aria-label="Fork workspace at this turn"
      >
        <Split size={14} />
      </button>,
    );
  }
  if (onRollback) {
    actionButtons.push(
      <button
        key="rollback"
        type="button"
        className={styles.turnFooterButton}
        onClick={handleRollback}
        title="Roll back to before this turn"
        aria-label="Roll back to before this turn"
      >
        <RotateCcw size={14} />
      </button>,
    );
  }

  if (!tokensNode && !elapsedNode && actionButtons.length === 0) return null;

  const hasMetadata = !!(tokensNode || elapsedNode);

  return (
    <div
      className={`${styles.turnFooter}${className ? ` ${className}` : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      {tokensNode}
      {tokensNode && elapsedNode && (
        <span className={styles.turnFooterDot} aria-hidden="true">·</span>
      )}
      {elapsedNode}
      {hasMetadata && actionButtons.length > 0 && (
        <span className={styles.turnFooterDot} aria-hidden="true">·</span>
      )}
      {actionButtons}
    </div>
  );
}

/** Inline progress bar rendered beneath a turn summary when tasks are present. */
function TaskProgressBar({
  completedCount,
  totalCount,
}: {
  completedCount: number;
  totalCount: number;
}) {
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const allDone = completedCount === totalCount;

  return (
    <div className={styles.taskProgressBar}>
      <div className={styles.taskProgressTrack}>
        <div
          className={`${styles.taskProgressFill} ${allDone ? styles.taskProgressDone : ""}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className={styles.taskProgressLabel}>
        {completedCount}/{totalCount} tasks
      </span>
    </div>
  );
}

/**
 * Renders all messages interleaved with completed turn summaries at the correct
 * chronological position. Uses a single store subscription + useMemo to avoid
 * per-message selectors and redundant re-renders during streaming.
 */
const EMPTY_CHECKPOINTS: import("../../types/checkpoint").ConversationCheckpoint[] = [];

type RollbackModalData = {
  workspaceId: string;
  checkpointId: string | null;
  messageId: string;
  messagePreview: string;
  messageContent: string;
  hasFileChanges: boolean;
};

const MessagesWithTurns = memo(function MessagesWithTurns({
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
  const completedTurns = useAppStore(
    (s) => s.completedTurns[sessionId] ?? EMPTY_COMPLETED_TURNS
  );
  const toggleCompletedTurn = useAppStore((s) => s.toggleCompletedTurn);
  const checkpoints = useAppStore(
    (s) => s.checkpoints[sessionId] ?? EMPTY_CHECKPOINTS
  );
  const openModal = useAppStore((s) => s.openModal);
  const showThinkingBlocks = useAppStore(
    (s) => s.showThinkingBlocks[sessionId] === true
  );
  // While the typewriter is finishing the drain after streamingContent cleared,
  // hide the just-added completed assistant message — StreamingMessage renders
  // it in-place, so showing both would duplicate the text.
  const pendingMessageId = useAppStore(
    (s) => s.pendingTypewriter[sessionId]?.messageId ?? null
  );
  const chatAttachments = useAppStore(
    (s) => s.chatAttachments[sessionId] ?? EMPTY_ATTACHMENTS
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
        sessionId: activeSessionId,
        checkpointId: target ? target.id : null,
        messageId: userMsg.id,
        messagePreview: userMsg.content.slice(0, 100),
        messageContent: userMsg.content,
        hasFileChanges: target
          ? checkpointHasFileChanges(target, checkpoints)
          : clearAllHasFileChanges(checkpoints),
      };
    },
    [checkpoints, messages, rollbackCheckpointByIdx, workspaceId, activeSessionId],
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
        const completedCount = tasks.filter((t) => t.status === "completed").length;
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
                <SyntheticContinuationMessage
                  body={syntheticBody}
                />
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
              <div className={styles.roleLabel}>You</div>
            )}
            {msg.role === "Assistant" && msg.thinking && showThinkingBlocks && (
              <ThinkingBlock content={msg.thinking} isStreaming={false} searchQuery={searchQuery} />
            )}
            <div className={styles.content}>
              {attachmentsByMessage.has(msg.id) && (
                <div className={styles.messageImages}>
                  {attachmentsByMessage.get(msg.id)!.map((att) =>
                    att.media_type === "application/pdf" ? (
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
                              const { loadAttachmentData } = await import(
                                "../../services/tauri"
                              );
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
                    ) : att.media_type === "text/plain" ? (
                      <div
                        key={att.id}
                        className={styles.messagePdf}
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
                      >
                        <FileText size={14} />
                        <span>{att.filename}</span>
                        <span className={styles.textFileSize}>
                          {att.size_bytes < 1024
                            ? `${att.size_bytes} B`
                            : `${(att.size_bytes / 1024).toFixed(0)} KB`}
                        </span>
                      </div>
                    ) : (
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
                    ),
                  )}
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
            onToggle={() => toggleCompletedTurn(workspaceId, globalIdx)}
            taskProgress={taskProgressByTurn.get(globalIdx)}
            assistantText={assistantTextByTurnId.get(turn.id) ?? ""}
            onFork={onForkTurn ? () => onForkTurn(turn.id) : undefined}
            onRollback={buildOnRollback(turn.id)}
            searchQuery={searchQuery}
          />
        ))}
    </>
  );
});

/**
 * Current tool activities section — subscribes to toolActivities for this workspace.
 * Isolated so streaming text changes don't cause re-renders here.
 */
const ToolActivitiesSection = memo(function ToolActivitiesSection({
  workspaceId,
  isRunning,
  searchQuery,
}: {
  workspaceId: string;
  isRunning: boolean;
  searchQuery: string;
}) {
  const activities = useAppStore(
    (s) => s.toolActivities[workspaceId] ?? EMPTY_ACTIVITIES
  );
  const [collapsed, setCollapsed] = useState(true);

  // Auto-collapse when a new turn starts (activities goes from 0 to non-zero)
  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (isRunning && activities.length > 0 && prevLengthRef.current === 0) {
      setCollapsed(true);
    }
    prevLengthRef.current = activities.length;
  }, [isRunning, activities.length]);

  if (activities.length === 0) return null;

  // Force-expand when the active search query matches inside any of this
  // section's activity summaries — otherwise marks would be silently
  // hidden behind the collapsed header and the user would see a non-zero
  // counter with no visible highlight.
  const queryHasMatch =
    !!searchQuery &&
    activities.some(
      (a) =>
        a.summary && a.summary.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  const isExpanded = !collapsed || queryHasMatch;

  return (
    <div className={styles.toolActivities} aria-live="polite" aria-atomic="true">
      <div className={styles.turnSummary}>
        <div
          className={styles.turnHeader}
          role="button"
          tabIndex={0}
          onClick={() => setCollapsed(!collapsed)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setCollapsed(!collapsed);
            }
          }}
        >
          <span className={styles.toolChevron}>
            {isExpanded ? "⌄" : "›"}
          </span>
          <span className={styles.turnLabel}>
            {activities.length} tool call{activities.length !== 1 ? "s" : ""}
            {isRunning && <span className={styles.inProgressNote}> in progress</span>}
          </span>
        </div>
        {isExpanded && (
          <div className={styles.turnActivities}>
            {activities.map((act: ToolActivity) => (
              <div key={act.toolUseId} className={styles.toolActivity}>
                <div className={styles.toolHeader}>
                  <span className={styles.toolName} style={{ color: toolColor(act.toolName) }}>{act.toolName}</span>
                  {act.summary && (
                    <span className={styles.toolSummary}>
                      <HighlightedPlainText text={act.summary} query={searchQuery} />
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * Shows a progress bar for the current in-progress turn, only when
 * task-related tools are among the current activities. Disappears when
 * the turn finalises (tasks move into CompletedTurn rendering).
 */
const CurrentTurnTaskProgress = memo(function CurrentTurnTaskProgress({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const completedTurns = useAppStore(
    (s) => s.completedTurns[workspaceId] ?? EMPTY_COMPLETED_TURNS
  );
  const toolActivities = useAppStore(
    (s) => s.toolActivities[workspaceId] ?? EMPTY_ACTIVITIES
  );

  const result = useMemo(
    () => deriveTasks(completedTurns, toolActivities),
    [completedTurns, toolActivities]
  );

  // Only render when the current turn has task tools
  if (!hasTaskActivity(toolActivities) || result.totalCount === 0) return null;

  return (
    <TaskProgressBar completedCount={result.completedCount} totalCount={result.totalCount} />
  );
});

/** Extract the @-query based on cursor position in the textarea. */
function extractMentionQuery(text: string, cursorPos: number): string | null {
  const before = text.slice(0, cursorPos);
  const atIndex = before.lastIndexOf("@");
  if (atIndex === -1) return null;
  // The @ must be at start of input or preceded by whitespace.
  if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) return null;
  const query = before.slice(atIndex + 1);
  // If query contains whitespace, the mention is "closed".
  if (/\s/.test(query)) return null;
  return query;
}

// Separate component for input area to prevent full ChatPanel re-renders on every keystroke
/** Convert a File/Blob to a base64 string (without the data: prefix). */
function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function ChatInputArea({
  onSend,
  onStop,
  isRunning,
  isRemote,
  selectedWorkspaceId,
  sessionId,
  repoId,
  projectPath,
  historyRef,
  historyIndexRef,
  draftRef,
  onAttachmentContextMenu,
  onAttachmentClick,
}: {
  onSend: (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => Promise<void>;
  onStop: () => void | Promise<void>;
  isRunning: boolean;
  isRemote: boolean;
  selectedWorkspaceId: string;
  sessionId: string;
  repoId: string | undefined;
  projectPath: string | undefined;
  historyRef: React.MutableRefObject<Record<string, string[]>>;
  historyIndexRef: React.MutableRefObject<number>;
  draftRef: React.MutableRefObject<string>;
  onAttachmentContextMenu?: (
    e: React.MouseEvent,
    attachment: DownloadableAttachment,
  ) => void;
  onAttachmentClick?: (
    e: React.MouseEvent,
    attachment: DownloadableAttachment,
  ) => void;
}) {
  const [chatInput, setChatInput] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [inputScrollTop, setInputScrollTop] = useState(0);
  const [slashPickerIndex, setSlashPickerIndex] = useState(0);
  const [slashPickerDismissed, setSlashPickerDismissed] = useState(false);
  const [slashCommands, setSlashCommandsLocal] = useState<SlashCommand[]>([]);
  const setSlashCommandsStore = useAppStore((s) => s.setSlashCommands);
  const setSlashCommands = useCallback(
    (cmds: SlashCommand[]) => {
      setSlashCommandsLocal(cmds);
      setSlashCommandsStore(selectedWorkspaceId, cmds);
    },
    [selectedWorkspaceId, setSlashCommandsStore],
  );
  const [filePickerIndex, setFilePickerIndex] = useState(0);
  const [filePickerDismissed, setFilePickerDismissed] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<FileEntry[]>([]);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const filesCache = useRef<Record<string, FileEntry[]>>({});
  const mentionedFilesRef = useRef<Set<string>>(new Set());
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const pluginRefreshToken = useAppStore((s) => s.pluginRefreshToken);
  const openSettings = useAppStore((s) => s.openSettings);

  const insertTranscript = useCallback((transcript: string) => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? cursorPos;
    const end = ta?.selectionEnd ?? cursorPos;
    setChatInput((currentInput) => {
      const next = insertTranscriptAtSelection(
        currentInput,
        transcript,
        start,
        end,
      );
      setCursorPos(next.cursor);
      requestAnimationFrame(() => {
        const current = textareaRef.current;
        if (!current) return;
        current.focus();
        current.selectionStart = current.selectionEnd = next.cursor;
      });
      return next.text;
    });
  }, [cursorPos]);

  const focusVoiceProvider = useAppStore((s) => s.focusVoiceProvider);
  const voice = useVoiceInput(
    insertTranscript,
    (providerId) => {
      focusVoiceProvider(providerId);
      openSettings("plugins");
    },
  );
  const voiceErrorOpensSettings = shouldOpenVoiceSettingsForError(
    voice.activeProvider,
  );

  // Esc cancels an active recording regardless of where focus is. The
  // textarea's onKeyDown also handles Esc when it has focus; clicking
  // the mic moves focus to the button, where Esc would otherwise just
  // defocus it instead of stopping the recording.
  //
  // While recording, Esc is treated as exclusively "cancel recording" —
  // we capture it ahead of bubbling handlers and stop propagation so
  // it doesn't also close an unrelated popover/modal that happens to
  // be open. Without this, the same keypress could cancel recording
  // *and* dismiss the surrounding UI, which feels jumpy.
  useEffect(() => {
    if (voice.state !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      voice.cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [voice.state, voice.cancel]);

  // Per-session draft storage: save input when switching away,
  // restore when switching back.
  const draftsRef = useRef<Record<string, string>>({});
  const prevSessionRef = useRef(sessionId);
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev !== sessionId) {
      // Save draft for the session we're leaving.
      draftsRef.current[prev] = chatInput;
      // Restore draft for the session we're entering.
      setChatInput(draftsRef.current[sessionId] ?? "");
      prevSessionRef.current = sessionId;
      // Reset file picker and attachment state for new session.
      setFilesLoaded(false);
      setWorkspaceFiles([]);
      mentionedFilesRef.current = new Set();
      // Clear staged attachments so they don't leak across sessions.
      setPendingAttachments((prev) => {
        for (const a of prev) {
          if (a.preview_url.startsWith("blob:")) URL.revokeObjectURL(a.preview_url);
        }
        return [];
      });
      voice.cancel();
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus the textarea when switching or creating sessions.
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [sessionId]);

  // Consume prefill text (e.g. from rollback) and focus the textarea.
  const chatInputPrefill = useAppStore((s) => s.chatInputPrefill);
  const setChatInputPrefill = useAppStore((s) => s.setChatInputPrefill);
  useEffect(() => {
    if (chatInputPrefill) {
      setChatInput(chatInputPrefill);
      setChatInputPrefill(null);
      // Focus and move cursor to end after React re-renders.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
      });
    }
  }, [chatInputPrefill, setChatInputPrefill]);

  const refreshSlashCommands = useCallback(() => {
    listSlashCommands(projectPath, selectedWorkspaceId)
      .then(setSlashCommands)
      .catch((e) => console.error("Failed to load slash commands:", e));
  }, [pluginRefreshToken, projectPath, selectedWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    listSlashCommands(projectPath, selectedWorkspaceId)
      .then((cmds) => {
        if (!cancelled) setSlashCommands(cmds);
      })
      .catch((e) => console.error("Failed to load slash commands:", e));
    return () => {
      cancelled = true;
    };
  }, [projectPath, selectedWorkspaceId]);

  // Filter by the command-name token (text before the first whitespace) so the
  // picker stays open while the user types arguments. This keeps the argument
  // hint visible for native commands like `/plugin install …`.
  const slashQuery = describeSlashQuery(chatInput);
  const slashQueryToken = slashQuery?.token ?? null;
  const slashHasArgs = slashQuery?.hasArgs ?? false;
  const slashResults = useMemo(
    () => (slashQueryToken === null ? [] : filterSlashCommands(slashCommands, slashQueryToken)),
    [slashCommands, slashQueryToken],
  );
  const showSlashPicker = slashQueryToken !== null && slashResults.length > 0 && !slashPickerDismissed;

  useEffect(() => {
    setSlashPickerIndex(0);
    setSlashPickerDismissed(false);
  }, [slashQueryToken]);

  // --- File mention picker ---

  const loadFiles = useCallback(async () => {
    if (filesCache.current[selectedWorkspaceId]) {
      setWorkspaceFiles(filesCache.current[selectedWorkspaceId]);
      setFilesLoaded(true);
      return;
    }
    try {
      const files = await listWorkspaceFiles(selectedWorkspaceId);
      filesCache.current[selectedWorkspaceId] = files;
      setWorkspaceFiles(files);
      setFilesLoaded(true);
    } catch (e) {
      console.error("Failed to load workspace files:", e);
    }
  }, [selectedWorkspaceId]);

  const mentionQuery = extractMentionQuery(chatInput, cursorPos);
  const mentionResults = useMemo(
    () => (mentionQuery === null ? [] : matchFiles(workspaceFiles, mentionQuery)),
    [workspaceFiles, mentionQuery],
  );
  const showFilePicker =
    mentionQuery !== null && mentionResults.length > 0 && !filePickerDismissed && filesLoaded;

  // Lazy-load file list on first @ trigger.
  useEffect(() => {
    if (mentionQuery !== null && !filesLoaded) {
      loadFiles();
    }
  }, [mentionQuery, filesLoaded, loadFiles]);

  // Reset picker index when query changes.
  useEffect(() => {
    setFilePickerIndex(0);
    setFilePickerDismissed(false);
  }, [mentionQuery]);

  const insertFileMention = useCallback(
    (file: FileEntry) => {
      const before = chatInput.slice(0, cursorPos);
      const atIndex = before.lastIndexOf("@");
      const after = chatInput.slice(cursorPos);
      const mention = `@${file.path}`;
      // Directories: no trailing space so the user can keep narrowing.
      // Files: add a trailing space to close the mention.
      const suffix = file.is_directory ? "" : " ";
      const newText = before.slice(0, atIndex) + mention + suffix + after;
      setChatInput(newText);
      const newCursor = atIndex + mention.length + suffix.length;
      setCursorPos(newCursor);
      if (!file.is_directory) {
        mentionedFilesRef.current.add(file.path);
      }
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          ta.selectionStart = ta.selectionEnd = newCursor;
          ta.focus();
        }
      });
    },
    [chatInput, cursorPos],
  );

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = "auto";
    // Set height to scrollHeight; CSS max-height will cap it
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [chatInput]);

  // -- Attachment helpers --

  const addAttachment = useCallback(async (file: Blob, filename: string, textContent?: string) => {
    if (isRemote) return; // Attachments not supported over remote transport
    if (!SUPPORTED_ATTACHMENT_TYPES.has(file.type)) {
      console.warn(`Unsupported file type: ${file.type}`);
      return;
    }
    const isPdf = SUPPORTED_DOCUMENT_TYPES.has(file.type);
    const isImage = SUPPORTED_IMAGE_TYPES.has(file.type);
    const isText = isTextFile(file.type);
    const sizeLimit = maxSizeFor(file.type);
    if (file.size > sizeLimit) {
      console.warn(
        `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${(sizeLimit / 1024 / 1024).toFixed(1)} MB)`,
      );
      return;
    }
    const data_base64 = await fileToBase64(file);
    let preview_url: string;
    if (isPdf) {
      const { generatePdfThumbnail } = await import("../../utils/pdfThumbnail");
      preview_url = await generatePdfThumbnail(await file.arrayBuffer()).catch(() => "");
      if (!preview_url) return;
    } else if (isImage) {
      preview_url = URL.createObjectURL(file);
    } else {
      preview_url = "";
    }
    const att: PendingAttachment = {
      id: crypto.randomUUID(),
      filename,
      media_type: file.type,
      data_base64,
      preview_url,
      size_bytes: file.size,
      text_content: isText ? (textContent ?? await file.text()) : null,
    };
    setPendingAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        if (preview_url.startsWith("blob:")) URL.revokeObjectURL(preview_url);
        return prev;
      }
      return [...prev, att];
    });
  }, [isRemote]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.preview_url.startsWith("blob:")) URL.revokeObjectURL(att.preview_url);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // Track current attachments in a ref so the unmount cleanup always
  // revokes the latest blob URLs (not the stale initial-render snapshot).
  const pendingAttachmentsRef = useRef(pendingAttachments);
  pendingAttachmentsRef.current = pendingAttachments;
  useEffect(() => {
    return () => {
      for (const a of pendingAttachmentsRef.current) {
        if (a.preview_url.startsWith("blob:")) URL.revokeObjectURL(a.preview_url);
      }
    };
  }, []);

  // Consume attachment prefill (e.g. from rollback) — convert the raw
  // base64 data back into PendingAttachment objects with preview URLs.
  const attachmentsPrefill = useAppStore((s) => s.pendingAttachmentsPrefill);
  const setAttachmentsPrefill = useAppStore((s) => s.setPendingAttachmentsPrefill);
  useEffect(() => {
    if (!attachmentsPrefill || attachmentsPrefill.length === 0) return;
    setAttachmentsPrefill(null);

    (async () => {
      for (const a of attachmentsPrefill) {
        const bytes = base64ToBytes(a.data_base64);
        const blob = new Blob([bytes], { type: a.media_type });
        await addAttachment(blob, a.filename, a.text_content ?? undefined);
      }
    })().catch((e) => console.error("Failed to restore attachment prefill:", e));
  }, [attachmentsPrefill, setAttachmentsPrefill, addAttachment]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        // Skip text/plain — pasting text should insert into the textarea,
        // not create a file attachment.
        if (item.type === "text/plain") continue;
        // Some clipboard writers (notably `navigator.clipboard.write` with
        // a ClipboardItem) expose the image both as a "string" item (its
        // data URL) and a "file" item. We must check the file variant —
        // getAsFile() returns null for string items, which would
        // silently drop the paste.
        if (item.kind !== "file") continue;
        if (SUPPORTED_ATTACHMENT_TYPES.has(item.type)) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const defaultName = item.type === "application/pdf"
              ? "pasted-document.pdf"
              : "pasted-image.png";
            addAttachment(file, file.name || defaultName);
          }
          return; // Only handle first attachment
        }
      }
      // If no supported items, let the default text paste proceed.
    },
    [addAttachment],
  );

  // Tauri intercepts native file drops before they reach the webview's HTML5
  // drag events. Use Tauri's onDragDropEvent to handle file drops, and fall
  // through to readFileAsBase64 (which validates type + size on the Rust side).
  //
  // The handler references addAttachment via a ref to avoid re-registering the
  // listener when the callback identity changes — re-registration causes a race
  // where the old listener's async cleanup hasn't fired yet and the same drop
  // event is processed by both the old and new listeners, duplicating files.
  const addAttachmentRef = useRef(addAttachment);
  addAttachmentRef.current = addAttachment;

  useEffect(() => {
    if (isRemote) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (cancelled) return;
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragActive(true);
          } else if (event.payload.type === "leave") {
            setDragActive(false);
          } else if (event.payload.type === "drop") {
            setDragActive(false);
            for (const filePath of event.payload.paths) {
              readFileAsBase64(filePath)
                .then((result) => {
                  if (cancelled) return;
                  const bytes = base64ToBytes(result.data_base64);
                  const blob = new Blob([bytes], { type: result.media_type });
                  addAttachmentRef.current(blob, result.filename, result.text_content ?? undefined);
                })
                .catch((err) =>
                  console.warn("Skipped dropped file:", err),
                );
            }
          }
        })
        .then((fn) => {
          if (cancelled) {
            fn(); // Already cleaned up — unlisten immediately
          } else {
            unlisten = fn;
          }
        });
    }).catch((err) => {
      console.warn("Failed to register drag-drop listener:", err);
      setDragActive(false);
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isRemote]); // Stable dep — no re-registration on callback changes

  const handleAttachClick = useCallback(async () => {
    const selected = await open({ multiple: true });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      try {
        const result = await readFileAsBase64(filePath);
        const bytes = base64ToBytes(result.data_base64);
        const blob = new Blob([bytes], { type: result.media_type });
        await addAttachment(blob, result.filename, result.text_content ?? undefined);
      } catch (err) {
        console.error("Failed to read file:", err);
      }
    }
  }, [addAttachment]);

  const handleSend = () => {
    voice.cancel();
    // Only include files whose @path tokens are still in the text, so that
    // removed references don't get expanded.
    const activeFiles = new Set<string>();
    for (const path of mentionedFilesRef.current) {
      if (chatInput.includes(`@${path}`)) {
        activeFiles.add(path);
      }
    }
    const files = activeFiles.size > 0 ? activeFiles : undefined;
    const attachmentPayload =
      pendingAttachments.length > 0
        ? pendingAttachments.map((a) => ({
            filename: a.filename,
            media_type: a.media_type,
            data_base64: a.data_base64,
            text_content: a.text_content ?? undefined,
          }))
        : undefined;
    onSend(chatInput, files, attachmentPayload);
    setChatInput("");
    // Revoke blob URLs to free memory (data: URLs don't need cleanup).
    for (const a of pendingAttachments) {
      if (a.preview_url.startsWith("blob:")) URL.revokeObjectURL(a.preview_url);
    }
    setPendingAttachments([]);
    mentionedFilesRef.current = new Set();
  };

  const planMode = useAppStore(
    (s) => s.planMode[sessionId] ?? false,
  );
  const setPlanMode = useAppStore((s) => s.setPlanMode);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && voice.state === "recording") {
      e.preventDefault();
      voice.cancel();
      return;
    }

    // Shift+Tab: toggle plan mode
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      setPlanMode(sessionId, !planMode);
      return;
    }

    // File mention picker navigation (takes priority over slash picker)
    if (showFilePicker) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFilePickerIndex((i) => Math.min(i + 1, mentionResults.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFilePickerIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const result = mentionResults[filePickerIndex];
        if (result) insertFileMention(result.file);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const result = mentionResults[filePickerIndex];
        if (result) insertFileMention(result.file);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setFilePickerDismissed(true);
        return;
      }
    }

    // Slash command picker navigation
    if (showSlashPicker) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashPickerIndex((i) => Math.min(i + 1, slashResults.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashPickerIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = slashResults[slashPickerIndex];
        if (cmd) {
          // If the user has already typed arguments after the command name,
          // keep what they typed; otherwise substitute the canonical name.
          const send = slashHasArgs ? chatInput : "/" + cmd.name;
          onSend(send);
          setChatInput("");
          // Native commands record their canonical name from inside the
          // handleSend dispatcher; record here only for file-based commands
          // that go straight to the agent.
          if (!cmd.kind) {
            recordSlashCommandUsage(selectedWorkspaceId, cmd.name)
              .then(refreshSlashCommands)
              .catch((e) => console.error("Failed to record slash command usage:", e));
          }
        }
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const cmd = slashResults[slashPickerIndex];
        if (cmd) {
          setChatInput("/" + cmd.name + " ");
          setSlashPickerDismissed(true);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashPickerDismissed(true);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    // History navigation with arrow keys
    const history = historyRef.current[sessionId] ?? [];
    if (history.length === 0) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (historyIndexRef.current === -1) {
        draftRef.current = chatInput;
        historyIndexRef.current = history.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      }
      setChatInput(history[historyIndexRef.current]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndexRef.current === -1) return;
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current += 1;
        setChatInput(history[historyIndexRef.current]);
      } else {
        historyIndexRef.current = -1;
        setChatInput(draftRef.current);
      }
    }
  };

  const showUltrathinkOverlay = hasUltrathink(chatInput);

  return (
    <div
      className={`${styles.inputArea}${dragActive ? ` ${styles.inputDragActive}` : ""}`}
    >
      {showFilePicker && (
        <FileMentionPicker
          results={mentionResults}
          selectedIndex={filePickerIndex}
          onSelect={insertFileMention}
          onHover={setFilePickerIndex}
        />
      )}
      {showSlashPicker && (
        <SlashCommandPicker
          commands={slashResults}
          selectedIndex={slashPickerIndex}
          onSelect={(cmd) => {
            const send = slashHasArgs ? chatInput : "/" + cmd.name;
            onSend(send);
            setChatInput("");
            if (!cmd.kind) {
              recordSlashCommandUsage(selectedWorkspaceId, cmd.name)
                .then(refreshSlashCommands)
                .catch((e) => console.error("Failed to record slash command usage:", e));
            }
          }}
          onHover={setSlashPickerIndex}
        />
      )}
      {pendingAttachments.length > 0 && (
        <div className={styles.attachmentStrip}>
          {pendingAttachments.map((att) => (
            <div key={att.id} className={styles.attachmentThumb} title={att.filename}>
              {isTextFile(att.media_type) ? (
                <div className={styles.textFileBadge}>
                  <FileText size={16} />
                  <span className={styles.textFileName}>{att.filename}</span>
                  <span className={styles.textFileSize}>
                    {att.size_bytes < 1024
                      ? `${att.size_bytes} B`
                      : `${(att.size_bytes / 1024).toFixed(0)} KB`}
                  </span>
                </div>
              ) : (
                <img
                  src={att.preview_url}
                  alt={att.filename}
                  onClick={(e) => {
                    // PDFs also render as an <img> here (preview_url is a blob
                    // URL of the first-page thumbnail), but their data_base64
                    // is PDF bytes — not renderable inside an <img>. Only open
                    // the lightbox for actual image MIME types.
                    if (!att.media_type.startsWith("image/")) return;
                    onAttachmentClick?.(e, {
                      filename: att.filename,
                      media_type: att.media_type,
                      data_base64: att.data_base64,
                    });
                  }}
                  onContextMenu={(e) =>
                    onAttachmentContextMenu?.(e, {
                      filename: att.filename,
                      media_type: att.media_type,
                      data_base64: att.data_base64,
                    })
                  }
                />
              )}
              <button
                className={styles.attachmentRemove}
                onClick={(e) => {
                  e.stopPropagation();
                  removeAttachment(att.id);
                }}
                title="Remove"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.inputTextWrap}>
        {showUltrathinkOverlay && (
          <div className={styles.inputHighlight} aria-hidden="true">
            <div style={{ transform: `translateY(-${inputScrollTop}px)` }}>
              {renderUltrathinkText(chatInput, {
                animated: true,
                styles: {
                  ultrathinkChar: styles.ultrathinkChar,
                  ultrathinkCharAnimated: styles.ultrathinkCharAnimated,
                },
              })}
            </div>
          </div>
        )}
        <textarea
          ref={textareaRef}
          // data-chat-input is the stable selector used by the global focus
          // shortcuts (Cmd+` and Cmd+0) in useKeyboardShortcuts.ts to move
          // focus into the prompt from anywhere in the app.
          data-chat-input
          className={`${styles.input}${planMode ? ` ${styles.inputPlanMode}` : ""}${
            showUltrathinkOverlay ? ` ${styles.inputWithHighlight}` : ""
          }`}
          value={chatInput}
          onChange={(e) => {
            setChatInput(e.target.value);
            setCursorPos(e.target.selectionStart ?? 0);
            setInputScrollTop(e.target.scrollTop);
          }}
          onSelect={(e) => {
            setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0);
          }}
          onScroll={(e) => {
            setInputScrollTop((e.target as HTMLTextAreaElement).scrollTop);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isRunning ? "Type to queue a message..." : "Send a message..."}
        />
      </div>
      <div className={styles.inputControls}>
        <div className={styles.inputControlsLeft}>
          <div className={styles.attachBtnWrap}>
            <button
              className={`${styles.attachBtn} ${attachMenuOpen ? styles.attachBtnActive : ""}`}
              onClick={() => setAttachMenuOpen((v) => !v)}
              title="Add files or connectors"
            >
              <Plus size={16} />
            </button>
            {attachMenuOpen && (
              <AttachMenu
                repoId={repoId}
                onAttachFiles={() => {
                  setAttachMenuOpen(false);
                  handleAttachClick();
                }}
                onClose={() => setAttachMenuOpen(false)}
                isRemote={isRemote}
              />
            )}
          </div>
          <ComposerToolbar
            sessionId={sessionId}
            disabled={isRunning}
          />
        </div>
        <div className={styles.inputControlsRight}>
          <SegmentedMeter
            sessionId={sessionId}
            workspaceId={selectedWorkspaceId}
            onClick={() => setContextPopoverOpen((v) => !v)}
          />
          {voice.state === "recording" && (
            <div className={styles.voiceRecordingStatus} aria-live="polite">
              <span className={styles.voiceWaveform} aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>{formatElapsedSeconds(voice.elapsedSeconds)}</span>
            </div>
          )}
          {voice.state === "starting" && (
            <div className={styles.voiceStatusText} aria-live="polite">
              <LoaderCircle
                size={12}
                className={styles.voiceStatusSpinner}
                aria-hidden="true"
              />
              <span>Starting…</span>
            </div>
          )}
          {voice.state === "transcribing" && (
            <div className={styles.voiceStatusText} aria-live="polite">
              <LoaderCircle
                size={12}
                className={styles.voiceStatusSpinner}
                aria-hidden="true"
              />
              <span>
                {voice.activeProvider?.name
                  ? `Transcribing with ${voice.activeProvider.name}`
                  : "Transcribing"}
              </span>
            </div>
          )}
          {voice.state === "error" && voice.error && (
            voiceErrorOpensSettings ? (
              <button
                type="button"
                className={styles.voiceErrorBtn}
                onClick={() => openSettings("plugins")}
                title={voice.error}
              >
                <AlertCircle size={12} className={styles.voiceErrorIcon} aria-hidden="true" />
                <span className={styles.voiceErrorText}>{voice.error}</span>
              </button>
            ) : (
              <button
                type="button"
                className={styles.voiceErrorBtn}
                onClick={() => voice.cancel()}
                title={`${voice.error}\n\nClick to dismiss`}
              >
                <AlertCircle size={12} className={styles.voiceErrorIcon} aria-hidden="true" />
                <span className={styles.voiceErrorText}>{voice.error}</span>
              </button>
            )
          )}
          <button
            type="button"
            className={`${styles.voiceBtn} ${voice.state === "recording" ? styles.voiceBtnRecording : ""} ${voice.state === "transcribing" || voice.state === "starting" ? styles.voiceBtnTranscribing : ""}`}
            onClick={() => {
              if (voice.state === "recording") voice.stop();
              else if (
                voice.state === "transcribing" ||
                voice.state === "starting"
              )
                voice.cancel();
              else void voice.start();
            }}
            disabled={isRunning}
            title={
              voice.state === "recording"
                ? "Stop voice input"
                : voice.state === "transcribing"
                  ? "Discard transcription"
                  : voice.state === "starting"
                    ? "Cancel"
                    : "Voice input"
            }
            aria-label={
              voice.state === "recording"
                ? "Stop voice input"
                : voice.state === "transcribing"
                  ? "Discard transcription"
                  : voice.state === "starting"
                    ? "Cancel"
                    : "Voice input"
            }
          >
            {voice.state === "transcribing" ? (
              <X size={16} />
            ) : voice.state === "starting" ? (
              <LoaderCircle size={16} className={styles.voiceStatusSpinner} />
            ) : (
              <Mic size={16} />
            )}
          </button>
          <button
            className={`${styles.sendBtn} ${isRunning ? styles.sendBtnStop : ""}`}
            onClick={isRunning ? onStop : handleSend}
            disabled={!isRunning && !chatInput.trim() && pendingAttachments.length === 0}
            title={isRunning ? "Stop agent" : "Send message"}
            aria-label={isRunning ? "Stop agent" : "Send message"}
          >
            {isRunning ? <Square size={16} /> : <Send size={16} />}
          </button>
          {contextPopoverOpen && (
            <ContextPopover
              sessionId={sessionId}
              workspaceId={selectedWorkspaceId}
              onClose={() => setContextPopoverOpen(false)}
              onCompact={() => { onSend("/compact"); }}
              onClear={() => { onSend("/clear"); }}
            />
          )}
        </div>
        <ChatToolbar
          sessionId={sessionId}
          workspaceId={selectedWorkspaceId}
          disabled={isRunning}
        />
      </div>
    </div>
  );
}
