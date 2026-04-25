import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import {
  cancelVoiceRecording,
  startVoiceRecording,
  stopAndTranscribeVoice,
} from "./voice";

describe("voice service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("starts the selected native provider", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await startVoiceRecording("voice-distil-whisper-candle");

    expect(invokeMock).toHaveBeenCalledWith("voice_start_recording", {
      providerId: "voice-distil-whisper-candle",
    });
  });

  it("stops and transcribes the selected native provider", async () => {
    invokeMock.mockResolvedValueOnce("hello");

    await expect(
      stopAndTranscribeVoice("voice-distil-whisper-candle"),
    ).resolves.toBe("hello");
    expect(invokeMock).toHaveBeenCalledWith("voice_stop_and_transcribe", {
      providerId: "voice-distil-whisper-candle",
    });
  });

  it("cancels the selected native provider", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await cancelVoiceRecording("voice-distil-whisper-candle");

    expect(invokeMock).toHaveBeenCalledWith("voice_cancel_recording", {
      providerId: "voice-distil-whisper-candle",
    });
  });

  it("passes null when no provider id is supplied", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await startVoiceRecording();

    expect(invokeMock).toHaveBeenCalledWith("voice_start_recording", {
      providerId: null,
    });
  });
});
