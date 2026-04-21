import React, { createContext, memo, useContext, useEffect, useRef, useState, useMemo, useCallback } from "react";
import { isAgentBusy } from "../../utils/agentStatus";
import Markdown from "react-markdown";
import { preprocessContent, MARKDOWN_COMPONENTS, REHYPE_PLUGINS, REMARK_PLUGINS } from "../../utils/markdown";
import { FileText, GitBranch, Plus, RotateCcw, Send, Split, Square, X } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolActivity, CompletedTurn } from "../../stores/useAppStore";
import {
  loadChatHistory,
  loadAttachmentsForWorkspace,
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
import { findLatestPlanFilePath } from "./planFilePath";
import type { PermissionLevel } from "../../stores/useAppStore";
import { open } from "@tauri-apps/plugin-dialog";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { extractLatestCallUsage } from "../../utils/extractLatestCallUsage";
import type { SlashCommand, FileEntry } from "../../services/tauri";
import type { ChatMessage, ChatAttachment, AttachmentInput, PendingAttachment } from "../../types/chat";
import { base64ToBytes } from "../../utils/base64";
import {
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS,
  maxSizeFor,
} from "../../utils/attachmentValidation";
import { useAgentStream } from "../../hooks/useAgentStream";
import { useTypewriter } from "../../hooks/useTypewriter";
import { extractToolSummary } from "../../hooks/toolSummary";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { ChatToolbar } from "./ChatToolbar";
import { WorkspaceActions } from "./WorkspaceActions";
import { SlashCommandPicker, filterSlashCommands } from "./SlashCommandPicker";
import { AttachMenu } from "./AttachMenu";
import { FileMentionPicker, matchFiles } from "./FileMentionPicker";
import {
  describeSlashQuery,
  parseSlashInput,
  resolveNativeHandler,
} from "./nativeSlashCommands";
import { checkpointHasFileChanges, clearAllHasFileChanges, buildRollbackMap } from "../../utils/checkpointUtils";
import { ThinkingBlock } from "./ThinkingBlock";
import { CompactionDivider } from "./CompactionDivider";
import { SyntheticContinuationMessage } from "./SyntheticContinuationMessage";
import {
  extractCompactionEvents,
  parseCompactionSentinel,
  parseSyntheticSummarySentinel,
} from "../../utils/compactionSentinel";
import { PanelToggles } from "../shared/PanelToggles";
import { deriveTasks, processActivities, turnHasTaskActivity, hasTaskActivity } from "../../hooks/useTaskTracker";
import type { TaskTrackerResult, TrackedTask } from "../../hooks/useTaskTracker";
import { ScrollToBottomPill } from "./ScrollToBottomPill";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import { debugChat } from "../../utils/chatDebug";
import styles from "./ChatPanel.module.css";
import caretStyles from "./caret.module.css";

import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../../utils/spinnerFrames";
import { formatTokens } from "./formatTokens";

/** Format a duration in seconds as "15s" or "2m 34s". */
function shouldDisable1mContext(modelId: string | null): boolean {
  if (!modelId) return false;
  const entry = MODELS.find((m) => m.id === modelId);
  return entry ? entry.contextWindowTokens < 1_000_000 : false;
}

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
function PdfThumbnail({ dataBase64, attachmentId, filename, className }: {
  dataBase64?: string;
  attachmentId?: string;
  filename: string;
  className?: string;
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

  if (!src) {
    return (
      <div className={styles.messagePdf}>
        <FileText size={16} />
        <span>{filename}</span>
      </div>
    );
  }
  return <img src={src} alt={filename} className={className} />;
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

  // Prompt history: stores past user inputs per workspace.
  const historyRef = useRef<Record<string, string[]>>({});
  const historyIndexRef = useRef(-1);
  const draftRef = useRef("");

  useAgentStream();

  const defaultBranchesMap = useAppStore((s) => s.defaultBranches);

  const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
  const repo = repositories.find((r) => r.id === ws?.repository_id);
  const defaultBranch = repo ? defaultBranchesMap[repo.id] : undefined;
  const messages = selectedWorkspaceId
    ? chatMessages[selectedWorkspaceId] || []
    : [];
  // Subscribe only to boolean — avoids re-render on every streaming character
  const hasStreaming = useAppStore(
    (s) => !!(selectedWorkspaceId && s.streamingContent[selectedWorkspaceId])
  );
  const hasPendingTypewriter = useAppStore(
    (s) => !!(selectedWorkspaceId && s.pendingTypewriter[selectedWorkspaceId])
  );
  const hasThinking = useAppStore(
    (s) => !!(selectedWorkspaceId && s.streamingThinking[selectedWorkspaceId])
  );
  const showThinkingBlocks = useAppStore(
    (s) => selectedWorkspaceId ? s.showThinkingBlocks[selectedWorkspaceId] === true : false
  );
  // Subscribe only to count — avoids re-render on tool activity content changes
  const activitiesCount = useAppStore(
    (s) => (selectedWorkspaceId ? (s.toolActivities[selectedWorkspaceId] || []).length : 0)
  );
  const completedTurnsCount = useAppStore(
    (s) => (selectedWorkspaceId ? (s.completedTurns[selectedWorkspaceId] || []).length : 0)
  );
  const permissionLevelMap = useAppStore((s) => s.permissionLevel);
  const setPermissionLevel = useAppStore((s) => s.setPermissionLevel);
  const permissionLevel = selectedWorkspaceId
    ? permissionLevelMap[selectedWorkspaceId] ?? "full"
    : "full";
  const pendingQuestion = useAppStore(
    (s) => (selectedWorkspaceId ? s.agentQuestions[selectedWorkspaceId] ?? null : null)
  );
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const finishTypewriterDrainTop = useAppStore((s) => s.finishTypewriterDrain);
  const pendingPlan = useAppStore(
    (s) => (selectedWorkspaceId ? s.planApprovals[selectedWorkspaceId] ?? null : null)
  );
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const queuedMessage = useAppStore(
    (s) => (selectedWorkspaceId ? s.queuedMessages[selectedWorkspaceId] ?? null : null)
  );
  const setQueuedMessage = useAppStore((s) => s.setQueuedMessage);
  const clearQueuedMessage = useAppStore((s) => s.clearQueuedMessage);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const isRunning = isAgentBusy(ws?.agent_status);

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

  // Spinner and elapsed timer for running agent.
  const [spinnerIdx, setSpinnerIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isRunning) {
      startTimeRef.current = null;
      return;
    }
    if (!startTimeRef.current) {
      startTimeRef.current = Date.now();
      setElapsed(0);
      setSpinnerIdx(0);
    }
    const interval = setInterval(() => {
      setSpinnerIdx((i) => (i + 1) % SPINNER_FRAMES.length);
      if (startTimeRef.current) {
        const newElapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setElapsed((prev) => (prev === newElapsed ? prev : newElapsed));
      }
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isRunning]);

  const formatElapsed = formatElapsedSeconds;

  // Load persisted permission level when workspace changes.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    let cancelled = false;
    getAppSetting(`permission_level:${selectedWorkspaceId}`)
      .then((val) => {
        if (cancelled) return;
        if (val === "readonly" || val === "standard" || val === "full") {
          setPermissionLevel(selectedWorkspaceId, val);
        }
      })
      .catch((err) => {
        console.error("Failed to load permission level:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId, setPermissionLevel]);

  // Load chat history when workspace changes, seed prompt history from it.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    let cancelled = false;
    setError(null);
    historyIndexRef.current = -1;
    draftRef.current = "";

    const currentWs = useAppStore.getState().workspaces.find((w) => w.id === selectedWorkspaceId);
    const loadHistory = currentWs?.remote_connection_id
      ? sendRemoteCommand(currentWs.remote_connection_id, "load_chat_history", {
          workspace_id: selectedWorkspaceId,
        }).then((data) => (data as { messages?: ChatMessage[] })?.messages ?? data as ChatMessage[])
      : loadChatHistory(selectedWorkspaceId);

    const wsId = selectedWorkspaceId;
    const isLocal = !currentWs?.remote_connection_id;

    debugChat("ChatPanel", "load-history:start", {
      wsId,
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
          wsId,
          rawMessageCount: msgs.length,
          filteredMessageCount: filtered.length,
          messageIds: filtered.map((msg) => msg.id),
        });
        setChatMessages(wsId, filtered);
        historyRef.current[wsId] = filtered
          .filter((m) => m.role === "User")
          .map((m) => m.content);
        // Seed the ContextMeter from the last assistant message's per-call
        // token data. If none is available (fresh / pre-migration workspace),
        // clear any stale value so the meter hides.
        const callUsage = extractLatestCallUsage(filtered);
        const store = useAppStore.getState();
        if (callUsage) store.setLatestTurnUsage(wsId, callUsage);
        else store.clearLatestTurnUsage(wsId);
        // Phase 3: seed compactionEvents by scanning for COMPACTION: sentinels.
        store.setCompactionEvents(wsId, extractCompactionEvents(filtered));

        // Load attachments for this workspace's messages.
        if (isLocal) {
          loadAttachmentsForWorkspace(wsId)
            .then((atts) => {
              if (cancelled) return;
              useAppStore.getState().setChatAttachments(wsId, atts);
            })
            .catch((e) => console.error("Failed to load attachments:", e));
        }

        // Load persisted completed turns and reconstruct with correct positions.
        // Skip if the agent is currently running — the in-memory state from
        // finalizeTurn() is more current than the DB and must not be overwritten.
        if (isLocal) {
          const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId);
          const isRunning = isAgentBusy(ws?.agent_status);
          debugChat("ChatPanel", "load-completed-turns:gate", {
            wsId,
            isRunning,
            currentCompletedTurnIds: (useAppStore.getState().completedTurns[wsId] || []).map(
              (turn) => turn.id
            ),
          });
          if (!isRunning) {
            loadCompletedTurns(wsId)
              .then((turnData) => {
                if (cancelled) return;
                const turns = reconstructCompletedTurns(filtered, turnData);
                debugChat("ChatPanel", "load-completed-turns:success", {
                  wsId,
                  dbTurnIds: turnData.map((turn) => turn.checkpoint_id),
                  reconstructedTurnIds: turns.map((turn) => turn.id),
                });
                hydrateCompletedTurns(wsId, turns);
              })
              .catch((e) => console.error("Failed to load completed turns:", e));
          }
        }
      })
      .catch((e) => console.error("Failed to load chat history:", e));

    // Load checkpoints for rollback support.
    if (isLocal) {
      const setCheckpoints = useAppStore.getState().setCheckpoints;
      listCheckpoints(wsId)
        .then((cps) => {
          if (cancelled) return;
          setCheckpoints(wsId, cps);
        })
        .catch((e) => console.error("Failed to load checkpoints:", e));
    }

    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId, setChatMessages, hydrateCompletedTurns]);

  // Scroll to bottom unconditionally on workspace switch.
  useEffect(() => {
    if (selectedWorkspaceId) scrollToBottom();
  }, [selectedWorkspaceId, scrollToBottom]);

  // Auto-scroll when new content arrives — respects user intent via useStickyScroll.
  // Only scrolls if the user is already at/near the bottom.
  const prevMsgCountRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const wsId = selectedWorkspaceId;
    if (!wsId) return;
    const prev = prevMsgCountRef.current[wsId] ?? 0;
    const cur = messages.length;
    prevMsgCountRef.current[wsId] = cur;
    // Only trigger on genuinely new messages (count increase), not DB rehydration.
    if (cur > prev) handleContentChanged();
  }, [messages.length, selectedWorkspaceId, handleContentChanged]);

  useEffect(() => {
    if (completedTurnsCount > 0 || activitiesCount > 0 || pendingQuestion || pendingPlan) {
      handleContentChanged();
    }
  }, [completedTurnsCount, activitiesCount, pendingQuestion, pendingPlan, handleContentChanged]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    debugChat("ChatPanel", "state", {
      wsId: selectedWorkspaceId,
      isRunning,
      messageCount: messages.length,
      activitiesCount,
      completedTurnsCount,
      hasStreaming,
    });
  }, [
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
    if (isRunning || !selectedWorkspaceId || !queuedMessage) return;
    // Agent just finished — dispatch the queued message.
    const { content, mentionedFiles, attachments } = queuedMessage;
    clearQueuedMessage(selectedWorkspaceId);
    const filesSet = mentionedFiles?.length ? new Set(mentionedFiles) : undefined;
    // Use a microtask to avoid calling handleSend during render.
    queueMicrotask(() => handleSendRef.current?.(content, filesSet, attachments));
  }, [isRunning, selectedWorkspaceId, queuedMessage, clearQueuedMessage]);

  if (!ws) return null;

  const handleSend = async (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => {
    let trimmed = content.trim();
    if ((!trimmed && !attachments?.length) || !selectedWorkspaceId) return;

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
        const currentModel = state.selectedModel[workspaceId] ?? "opus";
        const currentPermission: PermissionLevel =
          state.permissionLevel[workspaceId] ?? "full";
        const currentPlanMode = state.planMode[workspaceId] ?? false;
        const currentFastMode = state.fastMode[workspaceId] ?? false;
        const currentThinking = state.thinkingEnabled[workspaceId] ?? false;
        const currentChrome = state.chromeEnabled[workspaceId] ?? false;
        const currentEffort = state.effortLevel[workspaceId] ?? "auto";
        const planFilePath = findLatestPlanFilePath(workspaceId);
        const agentStatusLabel =
          typeof ws.agent_status === "string"
            ? ws.agent_status
            : `Error: ${ws.agent_status.Error}`;
        const isRemoteWorkspace = !!ws.remote_connection_id;

        const addLocalMessage = (text: string) => {
          addChatMessage(workspaceId, {
            id: crypto.randomUUID(),
            workspace_id: workspaceId,
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
          applySelectedModel(workspaceId, nextModel);

        const setPermissionLevelBound = async (level: PermissionLevel) => {
          const previous =
            useAppStore.getState().permissionLevel[workspaceId] ?? "full";
          useAppStore.getState().setPermissionLevel(workspaceId, level);
          try {
            await setAppSetting(`permission_level:${workspaceId}`, level);
          } catch (err) {
            useAppStore.getState().setPermissionLevel(workspaceId, previous);
            throw err;
          }
        };

        const setPlanModeBound = (enabled: boolean) => {
          useAppStore.getState().setPlanMode(workspaceId, enabled);
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
          const messages = await clearConversation(workspaceId, restoreFiles);
          store.rollbackConversation(workspaceId, "__clear__", messages);
          loadCompletedTurns(workspaceId)
            .then((turnData) => {
              const turns = reconstructCompletedTurns(messages, turnData);
              useAppStore.getState().setCompletedTurns(workspaceId, turns);
            })
            .catch((err) =>
              console.error("Failed to reload turns after /clear:", err),
            );
          loadAttachmentsForWorkspace(workspaceId)
            .then((atts) =>
              useAppStore.getState().setChatAttachments(workspaceId, atts),
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
        selectedWorkspaceId,
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
    if (selectedWorkspaceId) {
      clearAgentQuestion(selectedWorkspaceId);
      clearPlanApproval(selectedWorkspaceId);
      finishTypewriterDrainTop(selectedWorkspaceId);
    }

    setError(null);

    // Push to prompt history.
    const history = (historyRef.current[selectedWorkspaceId] ??= []);
    history.push(trimmed);
    historyIndexRef.current = -1;
    draftRef.current = "";
    const optimisticMsgId = crypto.randomUUID();
    addChatMessage(selectedWorkspaceId, {
      id: optimisticMsgId,
      workspace_id: selectedWorkspaceId,
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
        width: null,
        height: null,
        size_bytes: Math.ceil(a.data_base64.length * 0.75),
      }));
      useAppStore.getState().addChatAttachments(selectedWorkspaceId, optimisticAtts);
    }
    updateWorkspace(selectedWorkspaceId, { agent_status: "Running" });
    useAppStore.getState().clearUnreadCompletion(selectedWorkspaceId);

    try {
      if (ws?.remote_connection_id) {
        // Route to remote server via WebSocket.
        const state = useAppStore.getState();
        const selectedModel = state.selectedModel[selectedWorkspaceId] || null;
        const disable1mContext = shouldDisable1mContext(selectedModel);
        await sendRemoteCommand(ws.remote_connection_id, "send_chat_message", {
          workspace_id: selectedWorkspaceId,
          content: trimmed,
          mentioned_files: mentionedFilesArray,
          permission_level: permissionLevel,
          model: selectedModel,
          fast_mode: state.fastMode[selectedWorkspaceId] || false,
          thinking_enabled: state.thinkingEnabled[selectedWorkspaceId] || false,
          plan_mode: state.planMode[selectedWorkspaceId] || false,
          effort: state.effortLevel[selectedWorkspaceId] || null,
          chrome_enabled: state.chromeEnabled[selectedWorkspaceId] || false,
          disable_1m_context: disable1mContext,
        });
      } else {
        const state = useAppStore.getState();
        const model = state.selectedModel[selectedWorkspaceId] || undefined;
        const fastMode = state.fastMode[selectedWorkspaceId] || false;
        const thinkingEnabled = state.thinkingEnabled[selectedWorkspaceId] || false;
        const planMode = state.planMode[selectedWorkspaceId] || false;
        const effort = state.effortLevel[selectedWorkspaceId] || undefined;
        const chromeEnabled = state.chromeEnabled[selectedWorkspaceId] || false;
        const disable1mContext = shouldDisable1mContext(model ?? null);
        await sendChatMessage(
          selectedWorkspaceId,
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
    }
  };

  handleSendRef.current = handleSend;

  const handleStop = async () => {
    if (!selectedWorkspaceId) return;
    // Clear queued message — stopping means the user wants to take control.
    clearQueuedMessage(selectedWorkspaceId);
    try {
      if (ws?.remote_connection_id) {
        await sendRemoteCommand(ws.remote_connection_id, "stop_agent", {
          workspace_id: selectedWorkspaceId,
        });
      } else {
        await stopAgent(selectedWorkspaceId);
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

      <ScrollContext.Provider value={scrollContextValue}>
        <div className={styles.messages} ref={messagesContainerRef}>
          {messages.length === 0 && !hasStreaming ? (
            <div className={styles.empty}>
              Send a message to start a conversation
            </div>
          ) : (
            <>
              {selectedWorkspaceId && (
                <MessagesWithTurns
                  messages={messages}
                  workspaceId={selectedWorkspaceId}
                  isRunning={isRunning}
                  onForkTurn={isRemote ? undefined : handleFork}
                />
              )}

              {selectedWorkspaceId && hasThinking && showThinkingBlocks && (
                <StreamingThinkingBlock workspaceId={selectedWorkspaceId} isStreaming={isRunning ?? false} />
              )}

              {selectedWorkspaceId && (hasStreaming || hasPendingTypewriter) && (
                <StreamingMessage workspaceId={selectedWorkspaceId} />
              )}

              {selectedWorkspaceId && activitiesCount > 0 && (
                <ToolActivitiesSection
                  workspaceId={selectedWorkspaceId}
                  isRunning={isRunning ?? false}
                />
              )}

              {selectedWorkspaceId && (
                <CurrentTurnTaskProgress workspaceId={selectedWorkspaceId} />
              )}

              {pendingQuestion && (
                <AgentQuestionCard
                  question={pendingQuestion}
                  onRespond={async (answers) => {
                    if (!selectedWorkspaceId) return;
                    const wsId = selectedWorkspaceId;
                    const toolUseId = pendingQuestion.toolUseId;
                    // Send first; only clear the card on success. If the
                    // invoke fails (IPC error, session reset, …) the card
                    // stays visible so the user can retry instead of leaving
                    // the CLI blocked on an unanswerable can_use_tool.
                    try {
                      await submitAgentAnswer(wsId, toolUseId, answers);
                      clearAgentQuestion(wsId);
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
                    if (!selectedWorkspaceId) return;
                    const wsId = selectedWorkspaceId;
                    const toolUseId = pendingPlan.toolUseId;
                    try {
                      await submitPlanApproval(wsId, toolUseId, approved, reason);
                      clearPlanApproval(wsId);
                      // User action is authoritative for ending the plan
                      // phase — flip planMode off so the next turn triggers
                      // drift detection (backend `session_exited_plan` covers
                      // this already, but clearing the UI state keeps the
                      // toolbar chip in sync).
                      setPlanMode(wsId, false);
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
                  aria-label={`Processing, ${formatElapsed(elapsed)} elapsed`}
                >
                  <span className={styles.spinner} aria-hidden="true">{SPINNER_FRAMES[spinnerIdx]}</span>
                  <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
                </div>
              )}

              {queuedMessage && selectedWorkspaceId && (
                <div className={styles.queuedMessage}>
                  <span className={styles.queuedLabel}>Queued</span>
                  <span className={styles.queuedContent}>{queuedMessage.content}</span>
                  <button
                    className={styles.queuedCancel}
                    onClick={() => clearQueuedMessage(selectedWorkspaceId)}
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
        repoId={repo?.id}
        projectPath={repo?.path}
        historyRef={historyRef}
        historyIndexRef={historyIndexRef}
        draftRef={draftRef}
      />
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
}: {
  workspaceId: string;
  isStreaming: boolean;
}) {
  const thinking = useAppStore(
    (s) => s.streamingThinking[workspaceId] || ""
  );
  if (!thinking) return null;
  return <ThinkingBlock content={thinking} isStreaming={isStreaming} enableTypewriter />;
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
}: {
  workspaceId: string;
}) {
  const streaming = useAppStore(
    (s) => s.streamingContent[workspaceId] || ""
  );
  const pendingText = useAppStore(
    (s) => s.pendingTypewriter[workspaceId]?.text ?? ""
  );
  const isStreaming = useAppStore(
    (s) => isAgentBusy(s.workspaces.find((w) => w.id === workspaceId)?.agent_status)
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
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={MARKDOWN_COMPONENTS}
        >
          {preprocessContent(displayed)}
        </Markdown>
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
}) {
  const hasElapsed = typeof turn.durationMs === "number" && turn.durationMs > 0;
  const hasTokens =
    typeof turn.inputTokens === "number" && typeof turn.outputTokens === "number";
  const hasCopy = assistantText.length > 0;
  const hasFork = !!onFork;
  const hasRollback = !!onRollback;
  const showFooter = hasElapsed || hasTokens || hasCopy || hasFork || hasRollback;

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
            {collapsed ? "›" : "⌄"}
          </span>
          <span className={styles.turnLabel}>
            {turn.activities.length} tool call
            {turn.activities.length !== 1 ? "s" : ""}
            {turn.messageCount > 0 &&
              `, ${turn.messageCount} message${turn.messageCount !== 1 ? "s" : ""}`}
          </span>
        </div>
        {!collapsed && (
          <div className={styles.turnActivities}>
            {turn.activities.map((act: ToolActivity) => (
              <div key={act.toolUseId} className={styles.toolActivity}>
                <div className={styles.toolHeader}>
                  <span className={styles.toolName} style={{ color: toolColor(act.toolName) }}>
                    {act.toolName}
                  </span>
                  {(act.summary || act.inputJson) && (
                    <span className={styles.toolSummary}>
                      {act.summary || extractToolSummary(act.toolName, act.inputJson)}
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
}: {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  assistantText?: string;
  onFork?: () => void;
  onRollback?: () => void;
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
    <div className={styles.turnFooter} onClick={(e) => e.stopPropagation()}>
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

const MessagesWithTurns = memo(function MessagesWithTurns({
  messages,
  workspaceId,
  isRunning,
  onForkTurn,
}: {
  messages: ChatMessage[];
  workspaceId: string;
  isRunning: boolean;
  /** Handler invoked when the user forks a turn. Undefined disables the fork
   *  button (e.g. for remote workspaces where the command cannot run). */
  onForkTurn?: (checkpointId: string) => void;
}) {
  const completedTurns = useAppStore(
    (s) => s.completedTurns[workspaceId] ?? EMPTY_COMPLETED_TURNS
  );
  const toggleCompletedTurn = useAppStore((s) => s.toggleCompletedTurn);
  const checkpoints = useAppStore(
    (s) => s.checkpoints[workspaceId] ?? EMPTY_CHECKPOINTS
  );
  const openModal = useAppStore((s) => s.openModal);
  const showThinkingBlocks = useAppStore(
    (s) => s.showThinkingBlocks[workspaceId] === true
  );
  // While the typewriter is finishing the drain after streamingContent cleared,
  // hide the just-added completed assistant message — StreamingMessage renders
  // it in-place, so showing both would duplicate the text.
  const pendingMessageId = useAppStore(
    (s) => s.pendingTypewriter[workspaceId]?.messageId ?? null
  );
  const chatAttachments = useAppStore(
    (s) => s.chatAttachments[workspaceId] ?? EMPTY_ATTACHMENTS
  );

  // Pre-build a Map keyed by message_id for O(1) lookup in the render loop.
  const attachmentsByMessage = useMemo(() => {
    const map = new Map<string, ChatAttachment[]>();
    for (const att of chatAttachments) {
      const list = map.get(att.message_id);
      if (list) list.push(att);
      else map.set(att.message_id, [att]);
    }
    return map;
  }, [chatAttachments]);

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

  // Joined assistant text per turn, used by the "Copy output" action in the
  // turn footer. A turn's slice is [prevTurn.afterMessageIndex, afterMessageIndex).
  const assistantTextByTurnId = useMemo(() => {
    const map = new Map<string, string>();
    let prevBoundary = 0;
    for (const turn of completedTurns) {
      const text = messages
        .slice(prevBoundary, turn.afterMessageIndex)
        .filter((m) => m.role === "Assistant")
        .map((m) => m.content)
        .join("\n\n")
        .trim();
      map.set(turn.id, text);
      prevBoundary = turn.afterMessageIndex;
    }
    return map;
  }, [completedTurns, messages]);

  // Map user message index → checkpoint for the preceding turn.
  // Checks the message immediately before this user message (assistant or
  // user for tool-only turns) for a matching checkpoint. Index 0 always
  // maps to null (clear-all) when any checkpoints exist.
  const rollbackCheckpointByIdx = useMemo(
    () => buildRollbackMap(messages, checkpoints),
    [messages, checkpoints],
  );

  // Per-turn rollback data, keyed by turn.id. A turn's rollback target is
  // the checkpoint captured just before the triggering user message ran.
  // A turn's triggering user message is the first User message in its range
  // [prevBoundary, afterMessageIndex) — the checkpoint itself is anchored to
  // the last assistant message of the turn, so we can't use cp.message_id.
  const rollbackByTurnId = useMemo(() => {
    const result = new Map<
      string,
      {
        workspaceId: string;
        checkpointId: string | null;
        messageId: string;
        messagePreview: string;
        messageContent: string;
        hasFileChanges: boolean;
      }
    >();
    let prevBoundary = 0;
    for (const turn of completedTurns) {
      let userIdx = -1;
      for (let i = prevBoundary; i < turn.afterMessageIndex && i < messages.length; i++) {
        if (messages[i].role === "User") {
          userIdx = i;
          break;
        }
      }
      prevBoundary = turn.afterMessageIndex;
      if (userIdx === -1) continue;
      if (!rollbackCheckpointByIdx.has(userIdx)) continue;
      const target = rollbackCheckpointByIdx.get(userIdx) ?? null;
      const userMsg = messages[userIdx];
      result.set(turn.id, {
        workspaceId,
        checkpointId: target ? target.id : null,
        messageId: userMsg.id,
        messagePreview: userMsg.content.slice(0, 100),
        messageContent: userMsg.content,
        hasFileChanges: target
          ? checkpointHasFileChanges(target, checkpoints)
          : clearAllHasFileChanges(checkpoints),
      });
    }
    return result;
  }, [completedTurns, checkpoints, messages, workspaceId, rollbackCheckpointByIdx]);

  const buildOnRollback = (turnId: string) => {
    if (isRunning) return undefined;
    const data = rollbackByTurnId.get(turnId);
    if (!data) return undefined;
    return () => openModal("rollback", data);
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
      messageIds: messages.map((msg) => msg.id),
      turnLayout: completedTurns.map((turn) => ({
        id: turn.id,
        afterMessageIndex: turn.afterMessageIndex,
        postLastMessage: turn.afterMessageIndex >= messages.length,
        toolCount: turn.activities.length,
      })),
    });
  }, [workspaceId, messages, completedTurns]);

  const renderTurns = (position: number) => {
    const entries = turnsByPosition[position];
    if (!entries) return null;
    return entries.map(({ turn, globalIdx }) => (
      <TurnSummary
        key={turn.id}
        turn={turn}
        collapsed={turn.collapsed}
        onToggle={() => toggleCompletedTurn(workspaceId, globalIdx)}
        taskProgress={taskProgressByTurn.get(globalIdx)}
        assistantText={assistantTextByTurnId.get(turn.id) ?? ""}
        onFork={onForkTurn ? () => onForkTurn(turn.id) : undefined}
        onRollback={buildOnRollback(turn.id)}
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
              <ThinkingBlock content={msg.thinking} isStreaming={false} />
            )}
            <div className={styles.content}>
              {msg.role === "User" && attachmentsByMessage.has(msg.id) && (
                <div className={styles.messageImages}>
                  {attachmentsByMessage.get(msg.id)!.map((att) =>
                    att.media_type === "application/pdf" ? (
                      <PdfThumbnail
                        key={att.id}
                        dataBase64={att.data_base64 || undefined}
                        attachmentId={att.id}
                        filename={att.filename}
                        className={styles.messageImage}
                      />
                    ) : (
                      <img
                        key={att.id}
                        src={`data:${att.media_type};base64,${att.data_base64}`}
                        alt={att.filename}
                        className={styles.messageImage}
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
                <Markdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                >
                  {preprocessContent(msg.content)}
                </Markdown>
              ) : (
                msg.content
              )}
            </div>
          </div>
          )}
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
}: {
  workspaceId: string;
  isRunning: boolean;
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
            {collapsed ? "›" : "⌄"}
          </span>
          <span className={styles.turnLabel}>
            {activities.length} tool call{activities.length !== 1 ? "s" : ""}
            {isRunning && <span className={styles.inProgressNote}> in progress</span>}
          </span>
        </div>
        {!collapsed && (
          <div className={styles.turnActivities}>
            {activities.map((act: ToolActivity) => (
              <div key={act.toolUseId} className={styles.toolActivity}>
                <div className={styles.toolHeader}>
                  <span className={styles.toolName} style={{ color: toolColor(act.toolName) }}>{act.toolName}</span>
                  {act.summary && (
                    <span className={styles.toolSummary}>
                      {act.summary}
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
  repoId,
  projectPath,
  historyRef,
  historyIndexRef,
  draftRef,
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
  repoId: string | undefined;
  projectPath: string | undefined;
  historyRef: React.MutableRefObject<Record<string, string[]>>;
  historyIndexRef: React.MutableRefObject<number>;
  draftRef: React.MutableRefObject<string>;
}) {
  const [chatInput, setChatInput] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
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
  const pluginRefreshToken = useAppStore((s) => s.pluginRefreshToken);

  // Per-workspace draft storage: save input when switching away,
  // restore when switching back.
  const draftsRef = useRef<Record<string, string>>({});
  const prevWorkspaceRef = useRef(selectedWorkspaceId);
  useEffect(() => {
    const prev = prevWorkspaceRef.current;
    if (prev !== selectedWorkspaceId) {
      // Save draft for the workspace we're leaving.
      draftsRef.current[prev] = chatInput;
      // Restore draft for the workspace we're entering.
      setChatInput(draftsRef.current[selectedWorkspaceId] ?? "");
      prevWorkspaceRef.current = selectedWorkspaceId;
      // Reset file picker and attachment state for new workspace.
      setFilesLoaded(false);
      setWorkspaceFiles([]);
      mentionedFilesRef.current = new Set();
      // Clear staged attachments so they don't leak across workspaces.
      setPendingAttachments((prev) => {
        for (const a of prev) {
          if (a.preview_url.startsWith("blob:")) URL.revokeObjectURL(a.preview_url);
        }
        return [];
      });
    }
  }, [selectedWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-focus the textarea when switching or creating workspaces.
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [selectedWorkspaceId]);

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

  const addAttachment = useCallback(async (file: Blob, filename: string) => {
    if (isRemote) return; // Attachments not supported over remote transport
    if (!SUPPORTED_ATTACHMENT_TYPES.has(file.type)) {
      console.warn(`Unsupported file type: ${file.type}`);
      return;
    }
    const isPdf = SUPPORTED_DOCUMENT_TYPES.has(file.type);
    const sizeLimit = maxSizeFor(file.type);
    if (file.size > sizeLimit) {
      console.warn(
        `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${(sizeLimit / 1024 / 1024).toFixed(1)} MB)`,
      );
      return;
    }
    const data_base64 = await fileToBase64(file);
    // PDFs get a rendered first-page thumbnail; images use a blob URL.
    let preview_url: string;
    if (isPdf) {
      const { generatePdfThumbnail } = await import("../../utils/pdfThumbnail");
      preview_url = await generatePdfThumbnail(await file.arrayBuffer()).catch(() => "");
    } else {
      preview_url = URL.createObjectURL(file);
    }
    if (!preview_url) return; // PDF thumbnail generation failed
    const att: PendingAttachment = {
      id: crypto.randomUUID(),
      filename,
      media_type: file.type,
      data_base64,
      preview_url,
      size_bytes: file.size,
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
        await addAttachment(blob, a.filename);
      }
    })().catch((e) => console.error("Failed to restore attachment prefill:", e));
  }, [attachmentsPrefill, setAttachmentsPrefill, addAttachment]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
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
                  addAttachmentRef.current(blob, result.filename);
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
    const selected = await open({
      multiple: true,
      filters: [
        {
          name: "Images & Documents",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf"],
        },
      ],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      try {
        const result = await readFileAsBase64(filePath);
        const bytes = base64ToBytes(result.data_base64);
        const blob = new Blob([bytes], { type: result.media_type });
        await addAttachment(blob, result.filename);
      } catch (err) {
        console.error("Failed to read file:", err);
      }
    }
  }, [addAttachment]);

  const handleSend = () => {
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
    (s) => s.planMode[selectedWorkspaceId] ?? false,
  );
  const setPlanMode = useAppStore((s) => s.setPlanMode);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Shift+Tab: toggle plan mode
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      setPlanMode(selectedWorkspaceId, !planMode);
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
    const history = historyRef.current[selectedWorkspaceId] ?? [];
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
              <img src={att.preview_url} alt={att.filename} />
              <button
                className={styles.attachmentRemove}
                onClick={() => removeAttachment(att.id)}
                title="Remove"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        // data-chat-input is the stable selector used by the global focus
        // shortcuts (Cmd+` and Cmd+0) in useKeyboardShortcuts.ts to move
        // focus into the prompt from anywhere in the app.
        data-chat-input
        className={`${styles.input}${planMode ? ` ${styles.inputPlanMode}` : ""}`}
        value={chatInput}
        onChange={(e) => {
          setChatInput(e.target.value);
          setCursorPos(e.target.selectionStart ?? 0);
        }}
        onSelect={(e) => {
          setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={isRunning ? "Type to queue a message..." : "Send a message..."}
      />
      <div className={styles.inputControls}>
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
        <ChatToolbar
          workspaceId={selectedWorkspaceId}
          disabled={isRunning}
        />
        <button
          className={`${styles.sendBtn} ${isRunning ? styles.sendBtnStop : ""}`}
          onClick={isRunning ? onStop : handleSend}
          disabled={!isRunning && !chatInput.trim() && pendingAttachments.length === 0}
          title={isRunning ? "Stop agent" : "Send message"}
          aria-label={isRunning ? "Stop agent" : "Send message"}
        >
          {isRunning ? <Square size={16} /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
}
