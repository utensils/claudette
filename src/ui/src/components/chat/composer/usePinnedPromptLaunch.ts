import { useCallback } from "react";
import type { TFunction } from "i18next";
import { useAppStore } from "../../../stores/useAppStore";
import type { PinnedPrompt } from "../../../services/tauri";
import type { AttachmentInput, PendingAttachment } from "../../../types/chat";
import { extractMentionPaths } from "../queuedMessageEditing";
import { preparePinnedPromptTarget } from "../pinnedPromptLaunch";

/** Click handler for the pinned-prompts bar: configures (or creates) the
 *  target session, then either auto-sends the prompt or seeds the composer. */
export function usePinnedPromptLaunch({
  onSend,
  pendingAttachments,
  cancelVoice,
  selectedWorkspaceId,
  sessionId,
  setPendingAttachmentsBoth,
  setComposerMode,
  setChatInput,
  textareaRef,
  mentionedFilesRef,
  t,
}: {
  onSend: (
    content: string,
    mentionedFiles?: Set<string>,
    attachments?: AttachmentInput[],
  ) => Promise<void>;
  pendingAttachments: PendingAttachment[];
  cancelVoice: () => void;
  selectedWorkspaceId: string;
  sessionId: string;
  setPendingAttachmentsBoth: (
    sessionForUpdate: string,
    updater: (prev: PendingAttachment[]) => PendingAttachment[],
  ) => void;
  setComposerMode: (mode: "prompt") => void;
  setChatInput: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  mentionedFilesRef: React.MutableRefObject<Set<string>>;
  t: TFunction<"chat">;
}) {
  return useCallback(
    (pin: PinnedPrompt) => {
      // Auto-send cancels any in-flight recording, mirroring handleSend —
      // otherwise a one-click launch leaves the recorder running in the
      // background. A new-tab launch cancels regardless, since the recording
      // belongs to the tab being navigated away from.
      if (pin.auto_send || pin.new_session) cancelVoice();

      // Snapshot the composer payload synchronously. `preparePinnedPromptTarget`
      // awaits real IPC (setting persistence, session creation), and the user
      // could keep typing or attach a file in the meantime — the prompt they
      // clicked should ship with the state that was on screen at click time.
      const attachmentsAtClick = pendingAttachments;
      const mentionsAtClick = new Set(mentionedFilesRef.current);

      void (async () => {
        let target;
        try {
          // Applies the pin's tri-state toolbar overrides and its model.
          // For `new_session` pins this also creates, names, and selects the
          // tab; for everything else it configures the active session in
          // place, which is the pre-existing behaviour.
          //
          // Awaited rather than fired-and-forgotten: a cross-harness model
          // swap mints a fresh session id mid-flight, so sending before it
          // settles would dispatch against the id that's being replaced.
          target = await preparePinnedPromptTarget(pin, {
            workspaceId: selectedWorkspaceId,
            sessionId,
          });
        } catch (err) {
          console.error("[pinned-prompt] Failed to prepare the session:", err);
          useAppStore
            .getState()
            .addToast(
              t("pinned_prompt_launch_failed", { name: pin.display_name }),
            );
          return;
        }

        if (target.openedNewSession) {
          // `onSend` is bound to the session this composer renders, which is
          // no longer the target. Hand the prompt to the store instead and
          // let ChatPanel dispatch it once the new tab is active.
          //
          // Only the prompt text travels. Composer attachments and
          // picker-tracked mentions deliberately stay behind in *this*
          // tab's composer: they belong to the conversation the user was
          // having, not to a reusable named prompt, and silently relocating
          // a pasted screenshot into an unrelated review tab would be
          // surprising (and would clear it from where they put it). Any
          // `@path` baked into the prompt body still resolves — the drain in
          // `ChatPanelSessionView` re-extracts mentions from the text it
          // dispatches.
          const store = useAppStore.getState();
          if (pin.auto_send) {
            store.enqueueChatPrompt(target.sessionId, pin.prompt);
          } else {
            // Seed the new tab's composer instead. The session-switch effect
            // in ChatInputArea reads `chatDrafts[sessionId]` when it sees the
            // id change, so the text is already there when the tab renders.
            store.setChatDraft(target.sessionId, pin.prompt);
          }
          return;
        }

        // This component instance is shared across sessions — switching tabs
        // swaps the `sessionId` prop rather than remounting. A model-bearing
        // pin awaits real IPC above (longest on a cross-harness swap, which
        // builds a transcript prelude), so by the time we get here the
        // composer on screen may belong to a different session than the one
        // this click was for. `onSend` is still correctly bound to the
        // clicked session, but the composer mutations below are not
        // session-scoped, so they'd land on whatever tab is now visible —
        // wiping text the user typed there, or inserting the prompt into it.
        //
        // When we've been navigated away from, write to the clicked
        // session's persisted draft instead. `ChatInputArea` rehydrates from
        // `chatDrafts` on session switch, so the result is the same as if
        // the user had never left.
        const stillOnClickedSession =
          useAppStore.getState().selectedSessionIdByWorkspaceId[
            selectedWorkspaceId
          ] === sessionId;

        if (pin.auto_send) {
          // mentionedFilesRef only tracks paths inserted via the file picker
          // into the textarea, but a pinned prompt's text was never
          // picker-typed — so we extract any baked-in @path mentions from
          // pin.prompt itself, then union them with picker-tracked paths that
          // also appear in the prompt body.
          const activeFiles = extractMentionPaths(pin.prompt);
          for (const path of mentionsAtClick) {
            if (pin.prompt.includes(`@${path}`)) {
              activeFiles.add(path);
            }
          }
          const files = activeFiles.size > 0 ? activeFiles : undefined;
          const attachmentPayload =
            attachmentsAtClick.length > 0
              ? attachmentsAtClick.map((a) => ({
                  filename: a.filename,
                  media_type: a.media_type,
                  data_base64: a.data_base64,
                  text_content: a.text_content ?? undefined,
                }))
              : undefined;
          void onSend(pin.prompt, files, attachmentPayload);
          for (const a of attachmentsAtClick) {
            if (a.preview_url.startsWith("blob:"))
              URL.revokeObjectURL(a.preview_url);
          }
          if (stillOnClickedSession) {
            setComposerMode("prompt");
            setChatInput("");
            // `setPendingAttachmentsBoth` writes component-local state as
            // well as the slice, so it's only safe while this composer is
            // still showing the clicked session.
            setPendingAttachmentsBoth(sessionId, () => []);
            mentionedFilesRef.current = new Set();
          } else {
            const store = useAppStore.getState();
            store.setChatDraft(sessionId, "");
            store.setPendingAttachmentsForSession(sessionId, []);
          }
          return;
        }

        if (stillOnClickedSession) {
          setComposerMode("prompt");
          setChatInput((prev) => pin.prompt + (prev ? " " + prev : ""));
          textareaRef.current?.focus();
          return;
        }
        const store = useAppStore.getState();
        const existing = store.chatDrafts[sessionId] ?? "";
        store.setChatDraft(
          sessionId,
          pin.prompt + (existing ? " " + existing : ""),
        );
      })();
    },
    [
      onSend,
      pendingAttachments,
      cancelVoice,
      selectedWorkspaceId,
      sessionId,
      setPendingAttachmentsBoth,
      setComposerMode,
      setChatInput,
      textareaRef,
      mentionedFilesRef,
      t,
    ],
  );
}
