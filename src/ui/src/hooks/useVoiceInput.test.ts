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
  useLayoutEffect: () => undefined,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
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
        recordingMode: "native",
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
        recordingMode: "native",
      }),
    ]);
    voiceService.startVoiceRecording.mockResolvedValueOnce(undefined);

    await controller.start();
    controller.cancel();

    expect(voiceService.cancelVoiceRecording).toHaveBeenCalledWith(
      "voice-distil-whisper-candle",
    );
  });

  it("rolls back the native start when cancelled mid-await", async () => {
    // Repro for the blur-during-starting race: stop() can't shut down a
    // recording whose nativeProviderRef hasn't been set yet, so cancel()
    // must flip cancelledRef BEFORE startVoiceRecording resolves and the
    // post-await code in start() must honor it.
    const onTranscript = vi.fn();
    const controller = useVoiceInput(onTranscript, vi.fn());
    const startPromise = deferred<undefined>();
    voiceService.listVoiceProviders.mockResolvedValueOnce([
      provider({
        id: "voice-distil-whisper-candle",
        kind: "local-model",
        recordingMode: "native",
      }),
    ]);
    voiceService.startVoiceRecording.mockReturnValueOnce(startPromise.promise);

    const startCall = controller.start();
    controller.cancel(); // simulate blur arriving mid-start
    startPromise.resolve(undefined);
    await startCall;
    await flushPromises();

    // Provider was rolled back (cancelVoiceRecording fired) and the
    // controller didn't transition to "recording".
    expect(voiceService.cancelVoiceRecording).toHaveBeenCalledWith(
      "voice-distil-whisper-candle",
    );
  });

  it("ignores a stale native transcript after cancel and restart", async () => {
    const onTranscript = vi.fn();
    const controller = useVoiceInput(onTranscript, vi.fn());
    const firstTranscript = deferred<string>();
    voiceService.listVoiceProviders.mockResolvedValue([
      provider({
        id: "voice-distil-whisper-candle",
        kind: "local-model",
        recordingMode: "native",
      }),
    ]);
    voiceService.startVoiceRecording.mockResolvedValue(undefined);
    voiceService.stopAndTranscribeVoice.mockReturnValueOnce(
      firstTranscript.promise,
    );

    await controller.start();
    controller.stop();
    controller.cancel();
    await controller.start();
    firstTranscript.resolve("stale words");
    await flushPromises();

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("routes setup-required local providers to settings", async () => {
    const onNeedsSetup = vi.fn();
    const controller = useVoiceInput(vi.fn(), onNeedsSetup);
    voiceService.listVoiceProviders.mockResolvedValueOnce([
      provider({
        id: "voice-distil-whisper-candle",
        kind: "local-model",
        recordingMode: "native",
        status: "needs-setup",
        setupRequired: true,
      }),
    ]);

    await controller.start();

    expect(onNeedsSetup).toHaveBeenCalledOnce();
    expect(onNeedsSetup).toHaveBeenCalledWith("voice-distil-whisper-candle");
    expect(voiceService.startVoiceRecording).not.toHaveBeenCalled();
  });

  it("uses native platform dictation on macOS and inserts the transcript", async () => {
    const speechRecognition = vi.fn();
    const onTranscript = vi.fn();
    vi.stubGlobal("navigator", {
      language: "en-US",
      platform: "MacIntel",
      userAgent: "Mac OS X",
    });
    vi.stubGlobal("window", {
      SpeechRecognition: speechRecognition,
      webkitSpeechRecognition: undefined,
    });
    const controller = useVoiceInput(onTranscript, vi.fn());
    voiceService.listVoiceProviders.mockResolvedValueOnce([
      provider({
        id: "voice-platform-system",
        recordingMode: "native",
      }),
    ]);
    voiceService.startVoiceRecording.mockResolvedValueOnce(undefined);
    voiceService.stopAndTranscribeVoice.mockResolvedValueOnce(" spoken words ");

    await controller.start();
    controller.stop();
    await flushPromises();

    expect(speechRecognition).not.toHaveBeenCalled();
    expect(voiceService.startVoiceRecording).toHaveBeenCalledWith(
      "voice-platform-system",
    );
    expect(voiceService.stopAndTranscribeVoice).toHaveBeenCalledWith(
      "voice-platform-system",
    );
    expect(onTranscript).toHaveBeenCalledWith("spoken words");
  });

  it("requests setup-required platform permission from the mic action", async () => {
    const onNeedsSetup = vi.fn();
    const onTranscript = vi.fn();
    const controller = useVoiceInput(onTranscript, onNeedsSetup);
    voiceService.listVoiceProviders.mockResolvedValueOnce([
      provider({
        id: "voice-platform-system",
        recordingMode: "native",
        status: "needs-setup",
        statusLabel: "Needs Speech Recognition permission",
        setupRequired: true,
      }),
    ]);
    voiceService.startVoiceRecording.mockResolvedValueOnce(undefined);
    voiceService.stopAndTranscribeVoice.mockResolvedValueOnce(" platform words ");

    await controller.start();
    controller.stop();
    await flushPromises();

    expect(voiceService.startVoiceRecording).toHaveBeenCalledWith(
      "voice-platform-system",
    );
    expect(onNeedsSetup).not.toHaveBeenCalled();
    expect(onTranscript).toHaveBeenCalledWith("platform words");
  });

  it("routes denied platform permission to settings after the mic action", async () => {
    const onNeedsSetup = vi.fn();
    const controller = useVoiceInput(vi.fn(), onNeedsSetup);
    voiceService.listVoiceProviders.mockResolvedValueOnce([
      provider({
        id: "voice-platform-system",
        recordingMode: "native",
        status: "needs-setup",
        statusLabel: "Needs Speech Recognition permission",
        setupRequired: true,
      }),
    ]);
    voiceService.startVoiceRecording.mockRejectedValueOnce(
      "Needs Speech Recognition permission",
    );

    await controller.start();

    expect(voiceService.startVoiceRecording).toHaveBeenCalledWith(
      "voice-platform-system",
    );
    expect(onNeedsSetup).toHaveBeenCalledOnce();
    expect(onNeedsSetup).toHaveBeenCalledWith("voice-platform-system");
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
      provider({
        id: "voice-platform-system",
        recordingMode: "webview",
      }),
    ]);

    await controller.start();

    expect(speechRecognition).not.toHaveBeenCalled();
    expect(voiceService.startVoiceRecording).not.toHaveBeenCalled();
  });
});
