import { describe, expect, it } from "vitest";

import type { VoiceProviderInfo } from "../types/voice";
import {
  chooseVoiceProvider,
  describeSpeechRecognitionError,
  insertTranscriptAtSelection,
  isNativeVoiceProvider,
  shouldOpenVoiceSettingsForError,
} from "./voice";

function provider(
  overrides: Partial<VoiceProviderInfo> & Pick<VoiceProviderInfo, "id">,
): VoiceProviderInfo {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    description: "",
    kind: "platform",
    recordingMode: "webview",
    privacyLabel: "",
    offline: false,
    downloadRequired: false,
    modelSizeLabel: null,
    cachePath: null,
    acceleratorLabel: null,
    status: "ready",
    statusLabel: "Ready",
    enabled: true,
    selected: false,
    setupRequired: false,
    canRemoveModel: false,
    error: null,
    ...rest,
  };
}

describe("chooseVoiceProvider", () => {
  it("prefers the explicitly selected provider", () => {
    const selected = provider({
      id: "voice-distil-whisper-candle",
      kind: "local-model",
      selected: true,
      status: "needs-setup",
    });
    expect(
      chooseVoiceProvider([
        provider({ id: "voice-platform-system" }),
        selected,
      ]),
    ).toBe(selected);
  });

  it("prefers a ready local provider before platform fallback", () => {
    const local = provider({
      id: "voice-distil-whisper-candle",
      kind: "local-model",
      status: "ready",
    });
    expect(
      chooseVoiceProvider([
        provider({ id: "voice-platform-system" }),
        local,
      ]),
    ).toBe(local);
  });

  it("falls back to platform when local providers need setup", () => {
    const platform = provider({ id: "voice-platform-system" });
    expect(
      chooseVoiceProvider([
        provider({
          id: "voice-distil-whisper-candle",
          kind: "local-model",
          status: "needs-setup",
        }),
        platform,
      ]),
    ).toBe(platform);
  });

  it("falls back to platform when local provider engine is unavailable", () => {
    const platform = provider({ id: "voice-platform-system" });
    expect(
      chooseVoiceProvider([
        provider({
          id: "voice-distil-whisper-candle",
          kind: "local-model",
          status: "engine-unavailable",
        }),
        platform,
      ]),
    ).toBe(platform);
  });

  it("does not choose a disabled platform provider", () => {
    expect(
      chooseVoiceProvider([
        provider({
          id: "voice-platform-system",
          enabled: false,
          status: "unavailable",
        }),
      ]),
    ).toBeNull();
  });

  it("returns a selected setup-required platform provider for actionable setup", () => {
    const selected = provider({
      id: "voice-platform-system",
      selected: true,
      status: "needs-setup",
      statusLabel: "Needs Speech Recognition permission",
      setupRequired: true,
      error: "Enable Speech Recognition permission for Claudette.",
    });

    expect(chooseVoiceProvider([selected])).toBe(selected);
  });
});

describe("insertTranscriptAtSelection", () => {
  it("inserts transcript at the cursor with readable spacing", () => {
    expect(insertTranscriptAtSelection("hello world", "there", 5, 5)).toEqual({
      text: "hello there world",
      cursor: 11,
    });
  });

  it("replaces the selected range and preserves adjacent whitespace", () => {
    expect(insertTranscriptAtSelection("run old command", "new", 4, 7)).toEqual({
      text: "run new command",
      cursor: 7,
    });
  });

  it("does not add leading whitespace at the beginning", () => {
    expect(insertTranscriptAtSelection("", "hello", 0, 0)).toEqual({
      text: "hello",
      cursor: 5,
    });
  });
});

describe("isNativeVoiceProvider", () => {
  it("returns true for local model providers", () => {
    expect(
      isNativeVoiceProvider(
        provider({
          id: "voice-distil-whisper-candle",
          kind: "local-model",
          recordingMode: "native",
        }),
      ),
    ).toBe(true);
  });

  it("returns true for native platform providers", () => {
    expect(
      isNativeVoiceProvider(
        provider({
          id: "voice-platform-system",
          recordingMode: "native",
        }),
      ),
    ).toBe(true);
  });

  it("returns false for webview platform and external providers", () => {
    expect(
      isNativeVoiceProvider(
        provider({
          id: "voice-platform-system",
          recordingMode: "webview",
        }),
      ),
    ).toBe(false);
    expect(
      isNativeVoiceProvider(
        provider({
          id: "voice-cloud-provider",
          kind: "external",
          recordingMode: "webview",
        }),
      ),
    ).toBe(false);
  });
});

describe("shouldOpenVoiceSettingsForError", () => {
  it("opens settings for provider setup and engine problems", () => {
    expect(
      shouldOpenVoiceSettingsForError(
        provider({
          id: "voice-distil-whisper-candle",
          kind: "local-model",
          status: "needs-setup",
          setupRequired: true,
        }),
      ),
    ).toBe(true);
    expect(
      shouldOpenVoiceSettingsForError(
        provider({
          id: "voice-distil-whisper-candle",
          kind: "local-model",
          status: "engine-unavailable",
        }),
      ),
    ).toBe(true);
  });

  it("does not open settings for transient ready-provider errors", () => {
    expect(
      shouldOpenVoiceSettingsForError(
        provider({
          id: "voice-distil-whisper-candle",
          kind: "local-model",
          status: "ready",
        }),
      ),
    ).toBe(false);
    expect(shouldOpenVoiceSettingsForError(null)).toBe(false);
  });
});

describe("describeSpeechRecognitionError", () => {
  it("turns macOS permission check failures into actionable guidance", () => {
    expect(
      describeSpeechRecognitionError({
        error: "not-allowed",
        message: "Speech recognition service permission check has failed",
      }),
    ).toBe(
      "System dictation needs Microphone and Speech Recognition permission. Enable both for Claudette in System Settings, then restart the app.",
    );
  });

  it("preserves unknown platform details", () => {
    expect(
      describeSpeechRecognitionError({
        error: "aborted",
        message: "Recognition aborted by service",
      }),
    ).toBe("System dictation failed: Recognition aborted by service");
  });
});
