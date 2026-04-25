import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceProviderInfo } from "../types/voice";

const voiceService = vi.hoisted(() => ({
  cancelVoiceRecording: vi.fn(),
  listVoiceProviders: vi.fn(),
  startVoiceRecording: vi.fn(),
  stopAndTranscribeVoice: vi.fn(),
}));

vi.mock("../services/voice", () => voiceService);

vi.mock("react", () => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T): T =>
    callback,
  useEffect: () => undefined,
  useMemo: <T>(factory: () => T): T => factory(),
  useRef: <T>(initial: T): { current: T } => ({ current: initial }),
  useState: <T>(initial: T): [T, (next: T) => void] => [initial, vi.fn()],
}));

import { useVoiceInput } from "./useVoiceInput";

function provider(
  overrides: Partial<VoiceProviderInfo> & Pick<VoiceProviderInfo, "id">,
): VoiceProviderInfo {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    description: "",
    kind: "platform",
    privacyLabel: "",
    offline: false,
    downloadRequired: false,
    modelSizeLabel: null,
    cachePath: null,
    acceleratorLabel: null,
    status: "ready",
    statusLabel: "Ready",
    enabled: true,
    selected: true,
    setupRequired: false,
    canRemoveModel: false,
    error: null,
    ...rest,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useVoiceInput", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    Object.values(voiceService).forEach((mock) => mock.mockReset());
    vi.stubGlobal("navigator", {
      language: "en-US",
      platform: "Linux x86_64",
      userAgent: "Mozilla/5.0",
    });
    vi.stubGlobal("window", {
      SpeechRecognition: undefined,
      webkitSpeechRecognition: undefined,
    });
  });

  it("uses native start/stop and inserts the returned local transcript", async () => {
    const onTranscript = vi.fn();
    const controller = useVoiceInput(onTranscript, vi.fn());
    voiceService.listVoiceProviders.mockResolvedValueOnce([
      provider({
        id: "voice-distil-whisper-candle",
        kind: "local-model",
      }),
    ]);
    voiceService.startVoiceRecording.mockResolvedValueOnce(undefined);
    voiceService.stopAndTranscribeVoice.mockResolvedValueOnce(" hello ");

    await controller.start();
    controller.stop();
    await flushPromises();

    expect(voiceService.startVoiceRecording).toHaveBeenCalledWith(
      "voice-distil-whisper-candle",
    );
    expect(voiceService.stopAndTranscribeVoice).toHaveBeenCalledWith(
      "voice-distil-whisper-candle",
    );
    expect(onTranscript).toHaveBeenCalledWith("hello");
  });

  it("cancels an active native recording", async () => {
    const controller = useVoiceInput(vi.fn(), vi.fn());
    voiceService.listVoiceProviders.mockResolvedValueOnce([
      provider({
        id: "voice-distil-whisper-candle",
        kind: "local-model",
      }),
    ]);
    voiceService.startVoiceRecording.mockResolvedValueOnce(undefined);

    await controller.start();
    controller.cancel();

    expect(voiceService.cancelVoiceRecording).toHaveBeenCalledWith(
      "voice-distil-whisper-candle",
    );
  });

  it("routes setup-required local providers to settings", async () => {
    const onNeedsSetup = vi.fn();
    const controller = useVoiceInput(vi.fn(), onNeedsSetup);
    voiceService.listVoiceProviders.mockResolvedValueOnce([
      provider({
        id: "voice-distil-whisper-candle",
        kind: "local-model",
        status: "needs-setup",
        setupRequired: true,
      }),
    ]);

    await controller.start();

    expect(onNeedsSetup).toHaveBeenCalledOnce();
    expect(voiceService.startVoiceRecording).not.toHaveBeenCalled();
  });

  it("does not instantiate Web Speech on macOS", async () => {
    const speechRecognition = vi.fn();
    vi.stubGlobal("navigator", {
      language: "en-US",
      platform: "MacIntel",
      userAgent: "Mac OS X",
    });
    vi.stubGlobal("window", {
      SpeechRecognition: speechRecognition,
      webkitSpeechRecognition: undefined,
    });
    const controller = useVoiceInput(vi.fn(), vi.fn());
    voiceService.listVoiceProviders.mockResolvedValueOnce([
      provider({ id: "voice-platform-system" }),
    ]);

    await controller.start();

    expect(speechRecognition).not.toHaveBeenCalled();
    expect(voiceService.startVoiceRecording).not.toHaveBeenCalled();
  });
});
