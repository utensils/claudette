import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, FileText, LoaderCircle, Mic, Plus, Send, Square, Terminal as TerminalIcon, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { VoiceMeter } from "./VoiceMeter";
import { useAppStore } from "../../stores/useAppStore";
import {
  listSlashCommands,
  listWorkspaceFiles,
  readFileAsBase64,
  recordSlashCommandUsage,
} from "../../services/tauri";
import type { FileEntry, PinnedPrompt, SlashCommand } from "../../services/tauri";
import type {
  AttachmentInput,
  PendingAttachment,
  StoredAttachment,
} from "../../types/chat";
import { base64ToBytes } from "../../utils/base64";
import {
  MAX_ATTACHMENTS,
  SUPPORTED_ATTACHMENT_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  SUPPORTED_IMAGE_TYPES,
  isTextFile,
  maxSizeFor,
} from "../../utils/attachmentValidation";
import { type DownloadableAttachment } from "../../utils/attachmentDownload";
import {
  insertTranscriptAtSelection,
  shouldOpenVoiceSettingsForError,
} from "../../utils/voice";
import { useVoiceInput } from "../../hooks/useVoiceInput";
import { useVoiceHotkey } from "../../hooks/useVoiceHotkey";
import {
  eventToBinding,
  getEffectiveBindingById,
} from "../../hotkeys/bindings";
import { ComposerToolbar } from "./composer/ComposerToolbar";
import { ContextPopover } from "./composer/ContextPopover";
import { SegmentedMeter } from "./composer/SegmentedMeter";
import { AttachMenu } from "./AttachMenu";
import { FileMentionPicker, matchFiles } from "./FileMentionPicker";
import { PinnedPromptsBar } from "./PinnedPromptsBar";
import { SlashCommandPicker, filterSlashCommands } from "./SlashCommandPicker";
import { describeSlashQuery } from "./nativeSlashCommands";
import { hasUltrathink, renderUltrathinkText } from "./ultrathink";
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

/** Rebuild a `PendingAttachment[]` for a session from the slice's
 * `StoredAttachment[]`. Image preview blob URLs are regenerated from
 * `data_base64` (the underlying Blob is GC'd once the previous mount
 * dropped its reference). PDFs and non-image attachments don't get a
 * thumbnail re-generated here — that work is asynchronous and gated
 * inside `addAttachment`; on rehydration we leave `preview_url` empty
 * for those, so the row still renders the filename + size with no
 * thumbnail rather than blocking the mount on PDF.js. */
function hydratePendingFromSlice(sessionId: string): PendingAttachment[] {
  const stored = useAppStore.getState().pendingAttachmentsBySession[sessionId];
  if (!stored || stored.length === 0) return [];
  return stored.map((a) => ({
    id: a.id,
    filename: a.filename,
    media_type: a.media_type,
    data_base64: a.data_base64,
    preview_url: rehydrateImagePreviewUrl(a),
    size_bytes: a.size_bytes,
    text_content: a.text_content,
  }));
}

function rehydrateImagePreviewUrl(a: StoredAttachment): string {
  if (!SUPPORTED_IMAGE_TYPES.has(a.media_type)) return "";
  try {
    const bytes = base64ToBytes(a.data_base64);
    const blob = new Blob([bytes], { type: a.media_type });
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error("[chat-input] failed to rehydrate preview URL", e);
    return "";
  }
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

/**
 * Extract every closed `@path` token from `text` — i.e. an `@` at start of
 * string or preceded by whitespace, followed by a non-whitespace path. Used to
 * forward mentions baked into a pinned prompt to the backend on auto-send,
 * since those paths were never inserted via the file-mention picker and so
 * aren't tracked in `mentionedFilesRef`.
 */
function extractMentionPaths(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(^|\s)@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[2]);
  }
  return out;
}

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

// Separate component for input area to prevent full ChatPanel re-renders on every keystroke
export function ChatInputArea({
  onSend,
  onSendSteer,
  onSteerQueuedTop,
  onRunShellCommand,
  onStop,
  isRunning,
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
  const { t } = useTranslation("chat");
  const filesCache = useRef<Record<string, FileEntry[]>>({});
  const mentionedFilesRef = useRef<Set<string>>(new Set());
  // `pendingAttachments` is the local view (with transient blob URLs);
  // the slice (`pendingAttachmentsBySession`) is the per-session source
  // of truth so attachments survive any composer remount — including
  // the unmount that fires when `<ChatPanel>` is conditionally rendered
  // out of `AppLayout` whenever the user opens a file or diff. The
  // unmount cleanup further down revokes blob URLs on tear-down so we
  // don't leak them; the next mount calls `hydratePendingFromSlice` to
  // recreate the URLs from the persisted `data_base64` payload.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>(
    () => hydratePendingFromSlice(sessionId),
  );
  const setPendingAttachmentsBoth = useCallback(
    (
      sessionForUpdate: string,
      updater: (prev: PendingAttachment[]) => PendingAttachment[],
    ) => {
      setPendingAttachments((prev) => {
        const next = updater(prev);
        // Mirror to slice (without `preview_url` since it's transient).
        const stored: StoredAttachment[] = next.map((a) => ({
          id: a.id,
          filename: a.filename,
          media_type: a.media_type,
          data_base64: a.data_base64,
          size_bytes: a.size_bytes,
          text_content: a.text_content,
        }));
        useAppStore
          .getState()
          .setPendingAttachmentsForSession(sessionForUpdate, stored);
        return next;
      });
    },
    [],
  );
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

  const voiceToggleHotkey = useAppStore((s) => s.voiceToggleHotkey);
  const voiceHoldHotkey = useAppStore((s) => s.voiceHoldHotkey);
  const focusVoiceProvider = useAppStore((s) => s.focusVoiceProvider);
  // User-remappable bindings (`chat.steer-immediate` etc) — empty `{}` keeps
  // defaults active until the user customises one.
  const keybindings = useAppStore((s) => s.keybindings);
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
  useVoiceHotkey(voice, voiceToggleHotkey, voiceHoldHotkey);

  // VU meter dynamic-vs-static decision lives in the parent because it
  // depends on the OS reduced-motion preference and the active provider's
  // `recordingMode`. The meter itself is a child component so 30 Hz level
  // events don't re-render this large composer.
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  const nativeRecording = voice.activeProvider?.recordingMode === "native";
  const useDynamicMeter = !reducedMotion && nativeRecording;

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

  const handleUsePinnedPrompt = useCallback(
    (pin: PinnedPrompt) => {
      if (pin.auto_send) {
        // Cancel any in-flight voice recording before submitting, mirroring
        // handleSend — otherwise an auto-send click leaves the recorder
        // running in the background.
        voice.cancel();
        // Send immediately. mentionedFilesRef only tracks paths inserted via
        // the file picker into the textarea, but a pinned prompt's text was
        // never picker-typed — so we extract any baked-in @path mentions from
        // pin.prompt itself, then union them with picker-tracked paths that
        // also appear in the prompt body.
        const activeFiles = extractMentionPaths(pin.prompt);
        for (const path of mentionedFilesRef.current) {
          if (pin.prompt.includes(`@${path}`)) {
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
        onSend(pin.prompt, files, attachmentPayload);
        setComposerMode("prompt");
        setChatInput("");
        for (const a of pendingAttachments) {
          if (a.preview_url.startsWith("blob:"))
            URL.revokeObjectURL(a.preview_url);
        }
        setPendingAttachmentsBoth(sessionId, () => []);
        mentionedFilesRef.current = new Set();
        return;
      }
      setComposerMode("prompt");
      setChatInput((prev) => pin.prompt + (prev ? " " + prev : ""));
      textareaRef.current?.focus();
    },
    [onSend, pendingAttachments, voice],
  );

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
      setPendingAttachments((prevList) => {
        for (const a of prevList) {
          if (a.preview_url.startsWith("blob:")) URL.revokeObjectURL(a.preview_url);
        }
        return hydratePendingFromSlice(sessionId);
      });
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

  // Filter by the command-name token (text before the first whitespace) so the
  // picker stays open while the user types arguments. This keeps the argument
  // hint visible for native commands like `/plugin install …`.
  const slashQuery = composerMode === "prompt" ? describeSlashQuery(chatInput) : null;
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
    setPendingAttachmentsBoth(sessionId, (prev) => {
      if (prev.length >= MAX_ATTACHMENTS) {
        if (preview_url.startsWith("blob:")) URL.revokeObjectURL(preview_url);
        return prev;
      }
      return [...prev, att];
    });
  }, [isRemote, sessionId, setPendingAttachmentsBoth]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachmentsBoth(sessionId, (prev) => {
      const att = prev.find((a) => a.id === id);
      if (att?.preview_url.startsWith("blob:")) URL.revokeObjectURL(att.preview_url);
      return prev.filter((a) => a.id !== id);
    });
  }, [sessionId, setPendingAttachmentsBoth]);

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
  const tauriDragListenerActive = useRef(false);

  useEffect(() => {
    if (isRemote) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (cancelled) return;
      return getCurrentWebview()
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
            fn();
          } else {
            unlisten = fn;
            tauriDragListenerActive.current = true;
          }
        });
    }).catch((err) => {
      console.error(
        "[drag-drop] Tauri native listener failed, falling back to HTML5:",
        err,
      );
      tauriDragListenerActive.current = false;
      setDragActive(false);
    });

    return () => {
      cancelled = true;
      tauriDragListenerActive.current = false;
      unlisten?.();
    };
  }, [isRemote]);

  // HTML5 file-drop fallback: activates only when the Tauri native handler
  // failed to register (tauriDragListenerActive is false). The global dragover
  // preventDefault is always active to suppress the browser's default
  // file-navigation behavior.
  useEffect(() => {
    if (isRemote) return;

    const preventNav = (e: DragEvent) => {
      e.preventDefault();
    };

    const handleDragEnter = (e: DragEvent) => {
      if (tauriDragListenerActive.current) return;
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragActive(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      if (tauriDragListenerActive.current) return;
      if (e.relatedTarget) return;
      setDragActive(false);
    };

    const handleDrop = (e: DragEvent) => {
      if (tauriDragListenerActive.current) return;
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const files = e.dataTransfer.files;
      if (files.length === 0) return;
      for (const file of Array.from(files)) {
        void addAttachmentRef.current(file, file.name).catch((error) => {
          console.error("[drag-drop] Failed to add dropped attachment:", error);
        });
      }
    };

    document.addEventListener("dragover", preventNav);
    document.addEventListener("dragenter", handleDragEnter);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("drop", handleDrop);

    return () => {
      document.removeEventListener("dragover", preventNav);
      document.removeEventListener("dragenter", handleDragEnter);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("drop", handleDrop);
    };
  }, [isRemote]);

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
  const setPlanMode = useAppStore((s) => s.setPlanMode);

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

  return (
    <div
      className={`${styles.inputArea}${dragActive ? ` ${styles.inputDragActive}` : ""}${
        composerMode === "shell" ? ` ${styles.inputAreaShell}` : ""
      }`}
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
              {isTextFile(att.media_type) || !att.preview_url ? (
                // No preview URL: text files (always show filename
                // chip) AND non-image attachments rehydrated from the
                // slice without their thumbnail (PDFs lose their
                // first-page render on composer remount because the
                // underlying Blob is GC'd; the slice only stores
                // `data_base64`, not the transient thumbnail URL).
                // Without this fallback the row rendered as a broken
                // <img> after a remount even though the attachment
                // would still send correctly. The badge layout is
                // identical in both cases — file icon + name + size.
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
                title={t("remove_attachment")}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
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
          placeholder={
            composerMode === "shell"
              ? t("composer_placeholder_shell")
              : isRunning
                ? t("composer_placeholder_queued")
                : t("composer_placeholder_idle")
          }
        />
      </div>
      <div className={styles.inputControls}>
        <div className={styles.inputControlsLeft}>
          <div className={styles.attachBtnWrap}>
            <button
              className={`${styles.attachBtn} ${attachMenuOpen ? styles.attachBtnActive : ""}`}
              onClick={() => setAttachMenuOpen((v) => !v)}
              title={t("add_files_connectors")}
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
            disabled={isRunning}
            isRemote={isRemote}
          />
        </div>
        <div className={styles.inputControlsRight}>
          <SegmentedMeter
            sessionId={sessionId}
            onClick={() => setContextPopoverOpen((v) => !v)}
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
            disabled={isRunning}
            title={
              voice.state === "recording"
                ? t("voice_stop")
                : voice.state === "transcribing"
                  ? t("voice_discard")
                  : voice.state === "starting"
                    ? t("voice_cancel")
                    : t("voice_input")
            }
            aria-label={
              voice.state === "recording"
                ? t("voice_stop")
                : voice.state === "transcribing"
                  ? t("voice_discard")
                  : voice.state === "starting"
                    ? t("voice_cancel")
                    : t("voice_input")
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
            title={
              isRunning
                ? t("stop_agent")
                : composerMode === "shell"
                  ? t("run_shell_command")
                  : t("send_message")
            }
            aria-label={
              isRunning
                ? t("stop_agent")
                : composerMode === "shell"
                  ? t("run_shell_command")
                  : t("send_message")
            }
          >
            {isRunning ? <Square size={16} /> : <Send size={16} />}
          </button>
          {contextPopoverOpen && (
            <ContextPopover
              sessionId={sessionId}
              onClose={() => setContextPopoverOpen(false)}
              onCompact={() => { onSend("/compact"); }}
              onClear={() => { onSend("/clear"); }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
