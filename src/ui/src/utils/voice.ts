import i18n from "../i18n";
import type { VoiceProviderInfo } from "../types/voice";

export const PLATFORM_VOICE_PROVIDER_ID = "voice-platform-system";

export interface SpeechRecognitionErrorLike {
  error?: string;
  message?: string;
}

export function chooseVoiceProvider(
  providers: VoiceProviderInfo[],
): VoiceProviderInfo | null {
  const selected = providers.find(
    (provider) => provider.selected && provider.enabled,
  );
  if (selected) {
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
  const setupRequired = providers.find(
    (provider) => provider.enabled && provider.setupRequired,
  );
  return readyLocal ?? platform ?? setupRequired ?? null;
}

export function isNativeVoiceProvider(provider: VoiceProviderInfo): boolean {
  return provider.recordingMode === "native";
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
    return i18n.t("modals:voice_err_permission");
  }

  if (error === "audio-capture") {
    return i18n.t("modals:voice_err_audio_capture");
  }

  if (error === "network") {
    return i18n.t("modals:voice_err_network");
  }

  if (error === "no-speech") {
    return i18n.t("modals:voice_err_no_speech");
  }

  if (error === "language-not-supported") {
    return i18n.t("modals:voice_err_language");
  }

  return detail
    ? i18n.t("modals:voice_err_failed_detail", { detail })
    : i18n.t("modals:voice_err_failed");
}
