import { useCallback, useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useAppStore } from "../../../stores/useAppStore";
import {
  insertTranscriptAtSelection,
  shouldOpenVoiceSettingsForError,
} from "../../../utils/voice";
import { useVoiceInput } from "../../../hooks/useVoiceInput";
import { useVoiceHotkey } from "../../../hooks/useVoiceHotkey";
import { tooltipWithHotkey } from "../../../hotkeys/display";

/**
 * Voice dictation wiring for the chat composer: inserts transcripts at the
 * textarea selection, registers the voice hotkeys, derives the mic button
 * label/tooltip and VU-meter mode, and captures Esc while recording.
 */
export function useComposerVoice({
  textareaRef,
  cursorPos,
  setChatInput,
  setCursorPos,
  keybindings,
  isMac,
  openSettings,
  t,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  cursorPos: number;
  setChatInput: (value: string) => void;
  setCursorPos: (value: number) => void;
  keybindings: Parameters<typeof tooltipWithHotkey>[2];
  isMac: boolean;
  openSettings: (section: "plugins") => void;
  t: TFunction<"chat">;
}) {
  const insertTranscript = useCallback((transcript: string) => {
    const ta = textareaRef.current;
    const start = ta?.selectionStart ?? cursorPos;
    const end = ta?.selectionEnd ?? cursorPos;
    // Compute the next state outside the updater so the updater stays
    // pure. React may run a `setX(updater)` updater multiple times
    // (Strict Mode, concurrent rendering); calling other setters from
    // inside it triggers the "Cannot update a component while
    // rendering" dev warning and risks compounding side-effects.
    const next = insertTranscriptAtSelection(
      ta?.value ?? "",
      transcript,
      start,
      end,
    );
    setChatInput(next.text);
    setCursorPos(next.cursor);
    requestAnimationFrame(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus();
      current.selectionStart = current.selectionEnd = next.cursor;
    });
  }, [cursorPos, setChatInput, setCursorPos, textareaRef]);

  const voiceToggleHotkey = useAppStore((s) => s.voiceToggleHotkey);
  const voiceHoldHotkey = useAppStore((s) => s.voiceHoldHotkey);
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
  useVoiceHotkey(voice, voiceToggleHotkey, voiceHoldHotkey);
  const voiceButtonLabel = voice.state === "recording"
    ? t("voice_stop")
    : voice.state === "transcribing"
      ? t("voice_discard")
      : voice.state === "starting"
        ? t("voice_cancel")
        : t("voice_input");
  const voiceButtonTooltip =
    voice.state === "recording" || voice.state === "idle"
      ? tooltipWithHotkey(voiceButtonLabel, "voice.toggle", keybindings, isMac)
      : voiceButtonLabel;

  // VU meter dynamic-vs-static decision lives in the composer because it
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
  const voiceState = voice.state;
  const cancelVoice = voice.cancel;
  useEffect(() => {
    if (voiceState !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancelVoice();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [voiceState, cancelVoice]);

  return {
    voice,
    voiceErrorOpensSettings,
    voiceButtonLabel,
    voiceButtonTooltip,
    useDynamicMeter,
  };
}
