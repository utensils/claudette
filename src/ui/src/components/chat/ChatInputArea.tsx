import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, LoaderCircle, Mic, Plus, Send, Square, Terminal as TerminalIcon, X } from "lucide-react";
import { VoiceMeter } from "./VoiceMeter";
import { useAppStore } from "../../stores/useAppStore";
import { useEnvElapsedSeconds } from "../../hooks/useEnvElapsedSeconds";
import {
  listSlashCommands,
  listWorkspaceFiles,
  recordSlashCommandUsage,
} from "../../services/tauri";
import type { FileEntry, SlashCommand } from "../../services/tauri";
import type { AttachmentInput } from "../../types/chat";
import { type DownloadableAttachment } from "../../utils/attachmentDownload";
import {
  eventToBinding,
  getEffectiveBindingById,
} from "../../hotkeys/bindings";
import { tooltipWithHotkey } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import { ComposerAttachmentStrip } from "./composer/ComposerAttachmentStrip";
import { ComposerToolbar } from "./composer/ComposerToolbar";
import { ContextPopover } from "./composer/ContextPopover";
import { SegmentedMeter } from "./composer/SegmentedMeter";
import { UsageIndicator } from "./composer/UsageIndicator";
import {
  hydratePendingFromSlice,
  useComposerAttachments,
} from "./composer/useComposerAttachments";
import { COMPOSER_MIN_HEIGHT, useComposerResize } from "./composer/useComposerResize";
import { useComposerVoice } from "./composer/useComposerVoice";
import { usePinnedPromptLaunch } from "./composer/usePinnedPromptLaunch";
import { ResizeHandle } from "../layout/ResizeHandle";
import { AttachMenu } from "./AttachMenu";
import { FileMentionPicker, matchFiles } from "./FileMentionPicker";
import { PinnedPromptsBar } from "./PinnedPromptsBar";
import { SlashCommandPicker } from "./SlashCommandPicker";
import { useSlashPicker } from "../../hooks/useSlashPicker";
import { formatEnvProviderName } from "../../utils/workspaceEnvironment";
import { hasUltrathink, renderUltrathinkText } from "./ultrathink";
import { setPlanModeAndPersist } from "./planModePersistence";
import styles from "./ChatPanel.module.css";

type ComposerMode = "prompt" | "shell";

function parseComposerDraft(value: string): { mode: ComposerMode; text: string } {
  return value.startsWith("!")
    ? { mode: "shell", text: value.slice(1) }
    : { mode: "prompt", text: value };
}

function serializeComposerDraft(mode: ComposerMode, text: string): string {
  return mode === "shell" ? `!${text}` : text;
}

function normalizeShellCommand(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("!") ? trimmed.slice(1).trimStart() : trimmed;
}

export function shouldSteerQueuedTopOnImmediateSend({
  isRunning,
  hasQueuedMessages,
  hasComposerPayload,
  isRemote,
}: {
  isRunning: boolean;
  hasQueuedMessages: boolean;
  hasComposerPayload: boolean;
  isRemote: boolean;
}): boolean {
  return isRunning && !isRemote && hasQueuedMessages && !hasComposerPayload;
}

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
export function ChatInputArea({
  onSend,
  onSendSteer,
  onSteerQueuedTop,
  onRunShellCommand,
  onStop,
  isRunning,
  workspaceEnvironmentPreparing,
  isRemote,
  hasQueuedMessages,
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
  /** Skip-queue / mid-turn steer entry point. Called when the user presses
   *  the configured "send now" hotkey (defaults to Cmd/Ctrl+Enter) while
   *  the agent is running. ChatPanel should call steerQueuedChatMessage
   *  directly with this content instead of routing through the queue. */
  onSendSteer?: (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => void | Promise<void>;
  /** Steer the first queued message without consuming the current composer. */
  onSteerQueuedTop?: () => void | Promise<void>;
  onRunShellCommand: (command: string) => void | Promise<void>;
  onStop: () => void | Promise<void>;
  isRunning: boolean;
  workspaceEnvironmentPreparing: boolean;
  isRemote: boolean;
  hasQueuedMessages: boolean;
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
  // Lazy-init from the store so a saved draft is restored on mount (e.g. when
  // returning to a session after the component unmounted via workspace switch).
  const initialDraft = parseComposerDraft(
    useAppStore.getState().chatDrafts[sessionId] ?? "",
  );
  const [composerMode, setComposerMode] = useState<ComposerMode>(
    initialDraft.mode,
  );
  const [chatInput, setChatInput] = useState(initialDraft.text);
  const [cursorPos, setCursorPos] = useState(0);
  const [inputScrollTop, setInputScrollTop] = useState(0);
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
  const { t } = useTranslation("chat");
  // Live ticking elapsed-seconds while the env-provider layer is
  // resolving for this workspace. Drives the composer placeholder
  // ("Preparing direnv (12s)…") so the user sees that something is
  // actually happening on long Nix-flake / mise-toolchain warmups.
  const { plugin: envPlugin, seconds: envSeconds } = useEnvElapsedSeconds(
    selectedWorkspaceId,
  );
  const composerEnvPlaceholder = workspaceEnvironmentPreparing
    ? envPlugin && envSeconds !== null
      ? t("composer_placeholder_preparing_env_with_plugin", {
          defaultValue: "Preparing {{plugin}} ({{seconds}}s)…",
          plugin: formatEnvProviderName(envPlugin),
          seconds: envSeconds,
        })
      : t("composer_placeholder_preparing_env")
    : composerMode === "shell"
      ? t("composer_placeholder_shell")
      : isRunning
        ? t("composer_placeholder_queued")
        : t("composer_placeholder_idle");
  const filesCache = useRef<Record<string, FileEntry[]>>({});
  const mentionedFilesRef = useRef<Set<string>>(new Set());
  const {
    pendingAttachments,
    setPendingAttachments,
    pendingAttachmentsRef,
    setPendingAttachmentsBoth,
    dragActive,
    removeAttachment,
    handlePaste,
    handleAttachClick,
  } = useComposerAttachments({ sessionId, isRemote });
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const meterRef = useRef<HTMLButtonElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const { composerMaxBound, appliedComposerHeight, handleComposerResizeEnd } =
    useComposerResize(inputAreaRef);
  const pluginRefreshToken = useAppStore((s) => s.pluginRefreshToken);
  const openSettings = useAppStore((s) => s.openSettings);

  useEffect(() => {
    if (workspaceEnvironmentPreparing) {
      setContextPopoverOpen(false);
    }
  }, [workspaceEnvironmentPreparing]);

  // User-remappable bindings (`chat.steer-immediate` etc) — empty `{}` keeps
  // defaults active until the user customises one.
  const keybindings = useAppStore((s) => s.keybindings);
  const isMac = isMacHotkeyPlatform();
  const {
    voice,
    voiceErrorOpensSettings,
    voiceButtonLabel,
    voiceButtonTooltip,
    useDynamicMeter,
  } = useComposerVoice({
    textareaRef,
    cursorPos,
    setChatInput,
    setCursorPos,
    keybindings,
    isMac,
    openSettings,
    t,
  });
  const sendButtonLabel = isRunning
    ? t("stop_agent")
    : composerMode === "shell"
      ? t("run_shell_command")
      : t("send_message");
  const sendButtonTooltip = isRunning
    ? tooltipWithHotkey(sendButtonLabel, "global.dismiss-or-stop", keybindings, isMac)
    : workspaceEnvironmentPreparing
      ? t("send_disabled_preparing_env")
      : sendButtonLabel;

  const handleUsePinnedPrompt = usePinnedPromptLaunch({
    onSend,
    pendingAttachments,
    cancelVoice: voice.cancel,
    selectedWorkspaceId,
    sessionId,
    setPendingAttachmentsBoth,
    setComposerMode,
    setChatInput,
    textareaRef,
    mentionedFilesRef,
    t,
  });

  // Don't subscribe to chatDrafts — drafts are read inside the session-switch
  // effect (one-shot) and via getState() in the lazy initializer above. A
  // selector subscription would re-render this component on every keystroke
  // in *any* session.
  const setChatDraft = useAppStore((s) => s.setChatDraft);
  const draftSnapshotRef = useRef(serializeComposerDraft(composerMode, chatInput));
  useEffect(() => {
    draftSnapshotRef.current = serializeComposerDraft(composerMode, chatInput);
  }, [composerMode, chatInput]);

  const prevSessionRef = useRef(sessionId);
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev !== sessionId) {
      setChatDraft(prev, serializeComposerDraft(composerMode, chatInput));
      const nextDraft = parseComposerDraft(
        useAppStore.getState().chatDrafts[sessionId] ?? "",
      );
      setComposerMode(nextDraft.mode);
      setChatInput(nextDraft.text);
      prevSessionRef.current = sessionId;
      setFilesLoaded(false);
      setWorkspaceFiles([]);
      mentionedFilesRef.current = new Set();
      // Switch the local view to the new session's persisted
      // attachments (rehydrated with fresh blob URLs). Revoke the
      // previous mount's blob URLs first so we don't leak them — but
      // leave the *slice* entry for the previous session intact, so
      // its attachments come back when the user navigates back to it.
      for (const a of pendingAttachmentsRef.current) {
        if (a.preview_url.startsWith("blob:")) URL.revokeObjectURL(a.preview_url);
      }
      const nextAttachments = hydratePendingFromSlice(sessionId);
      pendingAttachmentsRef.current = nextAttachments;
      setPendingAttachments(nextAttachments);
      voice.cancel();
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      setChatDraft(sessionId, draftSnapshotRef.current);
    };
  }, [sessionId, setChatDraft]);

  // Auto-focus the textarea when switching or creating sessions.
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [sessionId]);

  // Consume prefill text (e.g. from rollback) and focus the textarea.
  const chatInputPrefill = useAppStore((s) => s.chatInputPrefill);
  const setChatInputPrefill = useAppStore((s) => s.setChatInputPrefill);
  useEffect(() => {
    if (chatInputPrefill) {
      const next = parseComposerDraft(chatInputPrefill);
      setChatInputPrefill(null);
      // Focus and move cursor to end after React re-renders.
      requestAnimationFrame(() => {
        setComposerMode(next.mode);
        setChatInput(next.text);
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (ta) {
            ta.focus();
            ta.selectionStart = ta.selectionEnd = ta.value.length;
          }
        });
      });
    }
  }, [chatInputPrefill, setChatInputPrefill]);

  const refreshSlashCommands = useCallback(() => {
    listSlashCommands(projectPath, selectedWorkspaceId)
      .then(setSlashCommands)
      .catch((e) => console.error("Failed to load slash commands:", e));
  }, [pluginRefreshToken, projectPath, selectedWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [projectPath, selectedWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The picker filters by the command-name token (text before the first
  // whitespace) so it stays open while the user types arguments — this
  // keeps the argument hint visible for native commands like `/plugin install …`.
  const handleSlashSelect = useCallback(
    (cmd: SlashCommand, send: string) => {
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
    },
    [onSend, selectedWorkspaceId, refreshSlashCommands],
  );

  const handleSlashAutocomplete = useCallback(
    (replacement: string) => setChatInput(replacement),
    [],
  );

  const slashPicker = useSlashPicker({
    chatInput,
    composerMode,
    slashCommands,
    onSelectCommand: handleSlashSelect,
    onAutocomplete: handleSlashAutocomplete,
  });

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

  const mentionQuery =
    composerMode === "prompt" ? extractMentionQuery(chatInput, cursorPos) : null;
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


  // Build the (content, files, attachments) payload from the current
  // composer state and clear local UI state. Shared by the normal Enter
  // path (handleSend) and the skip-queue / steer hotkey (handleSendSteer)
  // so they stay in lockstep — every key press should clear the same
  // pile of stuff.
  const consumeComposer = () => {
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
    const content = chatInput;
    setComposerMode("prompt");
    setChatInput("");
    // Revoke blob URLs to free memory (data: URLs don't need cleanup).
    for (const a of pendingAttachments) {
      if (a.preview_url.startsWith("blob:")) URL.revokeObjectURL(a.preview_url);
    }
    setPendingAttachmentsBoth(sessionId, () => []);
    mentionedFilesRef.current = new Set();
    return { content, files, attachmentPayload };
  };

  const handleSend = () => {
    if (workspaceEnvironmentPreparing) return;
    if (composerMode === "shell") {
      const command = normalizeShellCommand(chatInput);
      if (!command) return;
      consumeComposer();
      const history = (historyRef.current[sessionId] ??= []);
      history.push(serializeComposerDraft("shell", command));
      historyIndexRef.current = -1;
      draftRef.current = "";
      void onRunShellCommand(command);
      return;
    }
    const { content, files, attachmentPayload } = consumeComposer();
    onSend(content, files, attachmentPayload);
  };

  const handleSendSteer = () => {
    if (workspaceEnvironmentPreparing) return;
    if (!onSendSteer) return;
    // Steering only makes sense during a running turn — a regular send
    // path handles the idle case, and the agent has nothing to steer
    // when it isn't generating. Defensive guard so a misfired hotkey on
    // an idle session doesn't double-send.
    if (!isRunning) {
      handleSend();
      return;
    }
    if (shouldSteerQueuedTopOnImmediateSend({
      isRunning,
      isRemote,
      hasQueuedMessages,
      hasComposerPayload: !!chatInput.trim() || pendingAttachments.length > 0,
    }) && onSteerQueuedTop) {
      void onSteerQueuedTop();
      return;
    }
    // Mid-turn steering isn't supported over the remote transport yet
    // (Codex P2). Fall back to the normal send path — which queues for
    // after the current turn — instead of consuming the composer and
    // dropping the text on the floor.
    if (isRemote) {
      handleSend();
      return;
    }
    if (!chatInput.trim() && pendingAttachments.length === 0) return;
    const { content, files, attachmentPayload } = consumeComposer();
    void onSendSteer(content, files, attachmentPayload);
  };

  const planMode = useAppStore(
    (s) => s.planMode[sessionId] ?? false,
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && voice.state === "recording") {
      e.preventDefault();
      voice.cancel();
      return;
    }

    if (composerMode === "shell" && e.key === "Escape") {
      e.preventDefault();
      setComposerMode("prompt");
      return;
    }

    if (composerMode === "shell" && e.key === "Backspace" && chatInput.length === 0) {
      e.preventDefault();
      setComposerMode("prompt");
      return;
    }

    // Shift+Tab: toggle plan mode
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      void setPlanModeAndPersist(sessionId, !planMode);
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
    if (slashPicker.handleKeyDown(e)) {
      e.preventDefault();
      return;
    }

    // Skip-queue / steer: when the configured "send now" hotkey fires
    // (default Cmd/Ctrl+Enter), bypass the queue and inject the typed
    // content directly as a mid-turn steer. We intercept BEFORE the bare
    // Enter handler below so a Mod+Enter press doesn't get caught by it.
    // The binding is read from the hotkey settings system, so users can
    // remap it (e.g. Cmd+Shift+Enter) via the Keyboard settings page.
    const steerBinding = getEffectiveBindingById(
      "chat.steer-immediate",
      keybindings,
    );
    if (steerBinding) {
      const pressed = eventToBinding(e.nativeEvent, "key");
      if (pressed && pressed === steerBinding) {
        e.preventDefault();
        if (composerMode === "shell") handleSend();
        else handleSendSteer();
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

    if (e.key === "ArrowUp" && e.shiftKey) {
      e.preventDefault();
      if (historyIndexRef.current === -1) {
        draftRef.current = serializeComposerDraft(composerMode, chatInput);
        historyIndexRef.current = history.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      }
      const next = parseComposerDraft(history[historyIndexRef.current]);
      setComposerMode(next.mode);
      setChatInput(next.text);
    } else if (e.key === "ArrowDown" && e.shiftKey) {
      e.preventDefault();
      if (historyIndexRef.current === -1) return;
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current += 1;
        const next = parseComposerDraft(history[historyIndexRef.current]);
        setComposerMode(next.mode);
        setChatInput(next.text);
      } else {
        historyIndexRef.current = -1;
        const next = parseComposerDraft(draftRef.current);
        setComposerMode(next.mode);
        setChatInput(next.text);
      }
    }
  };

  const showUltrathinkOverlay = composerMode === "prompt" && hasUltrathink(chatInput);
  const sendDisabled = workspaceEnvironmentPreparing;
  // Env warmup only blocks dispatch; composer configuration remains editable.
  const configDisabled = false;

  return (
    <div
      ref={inputAreaRef}
      className={`${styles.inputArea}${dragActive ? ` ${styles.inputDragActive}` : ""}${
        composerMode === "shell" ? ` ${styles.inputAreaShell}` : ""
      }`}
      style={{ "--composer-h": `${appliedComposerHeight}px` } as React.CSSProperties}
    >
      <ResizeHandle
        direction="vertical"
        targetRef={inputAreaRef}
        cssVar="--composer-h"
        min={COMPOSER_MIN_HEIGHT}
        max={composerMaxBound}
        invert
        onResizeEnd={handleComposerResizeEnd}
      />
      {showFilePicker && (
        <FileMentionPicker
          results={mentionResults}
          selectedIndex={filePickerIndex}
          onSelect={insertFileMention}
          onHover={setFilePickerIndex}
        />
      )}
      {slashPicker.showSlashPicker && (
        <SlashCommandPicker
          commands={slashPicker.slashResults}
          selectedIndex={slashPicker.selectedIndex}
          onSelect={slashPicker.selectCommand}
          onHover={slashPicker.setSelectedIndex}
        />
      )}
      <ComposerAttachmentStrip
        attachments={pendingAttachments}
        onRemove={removeAttachment}
        onAttachmentClick={onAttachmentClick}
        onAttachmentContextMenu={onAttachmentContextMenu}
      />
      <PinnedPromptsBar
        repoId={repoId}
        onUsePinnedPrompt={handleUsePinnedPrompt}
      />
      <div
        className={`${styles.inputTextWrap}${
          composerMode === "shell" ? ` ${styles.inputTextWrapShell}` : ""
        }`}
      >
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
        {composerMode === "shell" && (
          <div className={styles.inputModePrefix} aria-hidden="true">
            <TerminalIcon size={13} />
            <span className={styles.inputModeBang}>!</span>
            <span>{t("shell_mode_label")}</span>
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
          }${composerMode === "shell" ? ` ${styles.inputShellMode}` : ""
          }`}
          value={chatInput}
          onChange={(e) => {
            const nextValue = e.target.value;
            const nextCursor = e.target.selectionStart ?? 0;
            if (composerMode === "prompt" && nextValue.startsWith("!")) {
              setComposerMode("shell");
              setChatInput(nextValue.slice(1));
              setCursorPos(Math.max(0, nextCursor - 1));
              return;
            }
            setChatInput(nextValue);
            setCursorPos(nextCursor);
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
          placeholder={composerEnvPlaceholder}
        />
      </div>
      <div className={styles.inputControls}>
        <div className={styles.inputControlsLeft}>
          <div className={styles.attachBtnWrap}>
            <button
              className={`${styles.attachBtn} ${attachMenuOpen ? styles.attachBtnActive : ""}`}
              onClick={() => setAttachMenuOpen((v) => !v)}
              title={t("add_files_connectors")}
              disabled={configDisabled}
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
            workspaceId={selectedWorkspaceId}
            repoId={repoId ?? null}
            configDisabled={configDisabled}
            sendDisabled={sendDisabled}
            isRunning={isRunning}
            isRemote={isRemote}
          />
        </div>
        <div className={styles.inputControlsRight}>
          <UsageIndicator
            workspaceId={selectedWorkspaceId}
            sessionId={sessionId}
          />
          <SegmentedMeter
            ref={meterRef}
            sessionId={sessionId}
            onClick={() => setContextPopoverOpen((v) => !v)}
            suspended={workspaceEnvironmentPreparing}
          />
          {voice.state === "recording" && (
            <VoiceMeter
              elapsedSeconds={voice.elapsedSeconds}
              useDynamicMeter={useDynamicMeter}
            />
          )}
          {voice.state === "starting" && (
            <div className={styles.voiceStatusText} aria-live="polite">
              <LoaderCircle
                size={12}
                className={styles.voiceStatusSpinner}
                aria-hidden="true"
              />
              <span>{t("voice_starting")}</span>
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
                  ? t("voice_transcribing_with", { provider: voice.activeProvider.name })
                  : t("voice_transcribing")}
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
                title={`${voice.error ?? ""}\n\n${t("voice_error_dismiss_hint")}`}
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
            disabled={isRunning || workspaceEnvironmentPreparing}
            data-tooltip={voiceButtonTooltip}
            aria-label={voiceButtonLabel}
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
            disabled={
              workspaceEnvironmentPreparing ||
              (!isRunning && !chatInput.trim() && pendingAttachments.length === 0)
            }
            data-tooltip={sendButtonTooltip}
            aria-label={sendButtonLabel}
          >
            {isRunning ? <Square size={16} /> : <Send size={16} />}
          </button>
          {contextPopoverOpen && !workspaceEnvironmentPreparing && (
            <ContextPopover
              sessionId={sessionId}
              onClose={() => setContextPopoverOpen(false)}
              onCompact={() => { onSend("/compact"); }}
              onClear={() => { onSend("/clear"); }}
              triggerRef={meterRef}
            />
          )}
        </div>
      </div>
    </div>
  );
}
