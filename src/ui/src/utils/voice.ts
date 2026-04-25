import type { VoiceProviderInfo } from "../types/voice";

export const PLATFORM_VOICE_PROVIDER_ID = "voice-platform-system";

export interface SpeechRecognitionErrorLike {
  error?: string;
  message?: string;
}

export function chooseVoiceProvider(
  providers: VoiceProviderInfo[],
): VoiceProviderInfo | null {
  const selected = providers.find((provider) => provider.selected);
  if (
    selected &&
    (selected.id !== PLATFORM_VOICE_PROVIDER_ID ||
      (selected.enabled && selected.status === "ready"))
  ) {
    return selected;
  }

  const readyLocal = providers.find(
    (provider) =>
      provider.kind === "local-model" &&
      provider.enabled &&
      provider.status === "ready",
  );
  const platform = providers.find(
    (provider) =>
      provider.id === PLATFORM_VOICE_PROVIDER_ID &&
      provider.enabled &&
      provider.status === "ready",
  );
  return readyLocal ?? platform ?? null;
}

export function isNativeVoiceProvider(provider: VoiceProviderInfo): boolean {
  return provider.kind === "local-model";
}

export function shouldOpenVoiceSettingsForError(
  provider: VoiceProviderInfo | null,
): boolean {
  if (!provider) return false;
  return (
    provider.setupRequired ||
    provider.status === "needs-setup" ||
    provider.status === "engine-unavailable" ||
    provider.status === "error"
  );
}

export function insertTranscriptAtSelection(
  text: string,
  transcript: string,
  start: number,
  end: number,
): { text: string; cursor: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const insertion = `${needsLeadingSpace ? " " : ""}${transcript}${needsTrailingSpace ? " " : ""}`;
  const nextText = before + insertion + after;
  return {
    text: nextText,
    cursor: before.length + insertion.length,
  };
}

export function describeSpeechRecognitionError(
  event: SpeechRecognitionErrorLike,
): string {
  const error = event.error?.trim() ?? "";
  const message = event.message?.trim() ?? "";
  const detail = message || error;
  const normalized = `${error} ${message}`.toLowerCase();

  if (
    error === "not-allowed" ||
    error === "service-not-allowed" ||
    normalized.includes("permission")
  ) {
    return "System dictation needs Microphone and Speech Recognition permission. Enable both for Claudette in System Settings, then restart the app.";
  }

  if (error === "audio-capture") {
    return "System dictation could not access a microphone. Check your input device and microphone permission.";
  }

  if (error === "network") {
    return "System dictation could not reach the platform speech recognition service. Try again, or use an offline provider when available.";
  }

  if (error === "no-speech") {
    return "No speech was detected. Try again closer to the microphone.";
  }

  if (error === "language-not-supported") {
    return "System dictation does not support the current input language.";
  }

  return detail ? `System dictation failed: ${detail}` : "System dictation failed.";
}
