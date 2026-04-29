import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, LoaderCircle } from "lucide-react";
import { ChatSearchBar } from "./ChatSearchBar";
import { useAppStore } from "../../stores/useAppStore";
import {
  loadAttachmentData,
  loadChatHistory,
  loadAttachmentsForSession,
  listCheckpoints,
  listSlashCommands,
  loadCompletedTurns,
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
  clearConversation,
  readPlanFile,
  loadDiffFiles,
  forkWorkspaceAtCheckpoint,
} from "../../services/tauri";
import { applySelectedModel } from "./applySelectedModel";
import { findLatestPlanFilePath } from "./planFilePath";
import type { PermissionLevel } from "../../stores/useAppStore";
import { reconstructCompletedTurns } from "../../utils/reconstructTurns";
import { extractLatestCallUsage } from "../../utils/extractLatestCallUsage";
import type { AttachmentInput, ChatMessage } from "../../types/chat";
import { debugChat } from "../../utils/chatDebug";
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
import {
  parseSlashInput,
  resolveNativeHandler,
} from "./nativeSlashCommands";
import { resolveUltrathinkEffort } from "./ultrathink";
import { extractCompactionEvents } from "../../utils/compactionSentinel";
import { PanelToggles } from "../shared/PanelToggles";
import { SessionTabs } from "./SessionTabs";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { PlanApprovalCard } from "./PlanApprovalCard";
import { WorkspaceActions } from "./WorkspaceActions";
import { ScrollToBottomPill } from "./ScrollToBottomPill";
import { useStickyScroll } from "../../hooks/useStickyScroll";
import styles from "./ChatPanel.module.css";
import { shouldDisable1mContext, formatElapsedSeconds } from "./chatHelpers";
import { ScrollContext } from "./ScrollContext";
import { StreamingThinkingBlock } from "./StreamingThinkingBlock";
import { StreamingMessage } from "./StreamingMessage";
import { MessagesWithTurns } from "./MessagesWithTurns";
import { ToolActivitiesSection } from "./ToolActivitiesSection";
import { CurrentTurnTaskProgress } from "./CurrentTurnTaskProgress";
import { ChatInputArea } from "./ChatInputArea";

export function ChatPanel() {
  const { t } = useTranslation("chat");
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
          chat_session_id: sessionId,
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
        if (callUsage) store.setLatestTurnUsage(sessionId, callUsage);
        else store.clearLatestTurnUsage(sessionId);
        // Phase 3: seed compactionEvents by scanning for COMPACTION: sentinels.
        store.setCompactionEvents(sessionId, extractCompactionEvents(filtered));

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
          const sessions = useAppStore.getState().sessionsByWorkspace[selectedWorkspaceId] ?? [];
          const thisSession = sessions.find((s) => s.id === sessionId);
          const isRunning = thisSession?.agent_status === "Running";
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
      chat_session_id: sessionId,
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
        const effort = resolveUltrathinkEffort(
          trimmed,
          state.effortLevel[sessionId],
        );
        await sendRemoteCommand(ws.remote_connection_id, "send_chat_message", {
          chat_session_id: sessionId,
          content: trimmed,
          mentioned_files: mentionedFilesArray,
          permission_level: permissionLevel,
          model: state.selectedModel[sessionId] || null,
          fast_mode: state.fastMode[sessionId] || false,
          thinking_enabled: state.thinkingEnabled[sessionId] || false,
          plan_mode: state.planMode[sessionId] || false,
          effort: effort ?? null,
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
                  sessionId={activeSessionId}
                  isStreaming={isRunning ?? false}
                  searchQuery={searchQuery}
                />
              )}

              {activeSessionId && (hasStreaming || hasPendingTypewriter) && (
                <StreamingMessage
                  sessionId={activeSessionId}
                  isStreaming={isRunning ?? false}
                  searchQuery={searchQuery}
                />
              )}

              {activeSessionId && activitiesCount > 0 && (
                <ToolActivitiesSection
                  sessionId={activeSessionId}
                  isRunning={isRunning ?? false}
                  searchQuery={searchQuery}
                  worktreePath={ws?.worktree_path}
                />
              )}

              {activeSessionId && (
                <CurrentTurnTaskProgress sessionId={activeSessionId} />
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
                      ? t("compacting_aria", { elapsed: formatElapsed(elapsed) })
                      : t("processing_aria", { elapsed: formatElapsed(elapsed) })
                  }
                >
                  <LoaderCircle size={14} className={styles.spinner} aria-hidden="true" />
                  {ws?.agent_status === "Compacting" && (
                    <span className={styles.compactingLabel}>{t("compacting_label")}</span>
                  )}
                  <span className={styles.elapsed}>{formatElapsed(elapsed)}</span>
                </div>
              )}

              {queuedMessage && activeSessionId && (
                <div className={styles.queuedMessage}>
                  <span className={styles.queuedLabel}>{t("queued_label")}</span>
                  <span className={styles.queuedContent}>{queuedMessage.content}</span>
                  <button
                    className={styles.queuedCancel}
                    onClick={() => clearQueuedMessage(activeSessionId)}
                    title={t("cancel_queued")}
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
                : [
                    // Non-image types (PDF + the text-shaped cards)
                    // route through the OS default-app handler — the
                    // Rust side stages the bytes to a temp file with
                    // the right extension and asks the system to open
                    // it. Same UX as left-clicking a PDF thumbnail.
                    {
                      label: "Open with default app",
                      onSelect: () => {
                        withBytes()
                          .then(openAttachmentWithDefaultApp)
                          .catch((err) =>
                            console.error("Open with default app failed:", err),
                          );
                      },
                    },
                  ]),
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
