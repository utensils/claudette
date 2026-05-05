import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelVoiceRecording,
  listVoiceProviders,
  startVoiceRecording,
  stopAndTranscribeVoice,
} from "../services/voice";
import type { VoiceProviderInfo } from "../types/voice";
import {
  PLATFORM_VOICE_PROVIDER_ID,
  chooseVoiceProvider,
  describeSpeechRecognitionError,
  isNativeVoiceProvider,
} from "../utils/voice";

type VoiceState =
  | "idle"
  | "starting"
  | "setup-required"
  | "recording"
  | "transcribing"
  | "error";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  length: number;
  item(index: number): SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
}

export interface VoiceInputController {
  state: VoiceState;
  elapsedSeconds: number;
  interimTranscript: string;
  error: string | null;
  activeProvider: VoiceProviderInfo | null;
  webSpeechSupported: boolean;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

export function useVoiceInput(
  onTranscript: (transcript: string) => void,
  onNeedsSetup: (providerId: string) => void,
): VoiceInputController {
  const [state, setState] = useState<VoiceState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<VoiceProviderInfo | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const nativeProviderRef = useRef<string | null>(null);
  const nativeRequestIdRef = useRef(0);
  const finalTranscriptRef = useRef("");
  const cancelledRef = useRef(false);
  const platformSpeechDisabled = useMemo(() => isMacPlatform(), []);

  const Recognition = useMemo(() => {
    if (platformSpeechDisabled) return undefined;
    if (typeof window === "undefined") return undefined;
    const speechWindow = window as SpeechRecognitionWindow;
    return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  }, [platformSpeechDisabled]);

  // Whether the in-webview Web Speech API is usable. Forced false on
  // macOS because we route through the native Apple Speech / Candle
  // providers there. Consumers should NOT use this as a proxy for
  // "voice input is available" — native providers cover macOS even
  // when this is false.
  const webSpeechSupported = Boolean(Recognition) && !platformSpeechDisabled;

  useEffect(() => {
    if (state !== "recording") return;
    const started = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => window.clearInterval(interval);
  }, [state]);

  // Auto-dismiss transient transcription errors so the toolbar doesn't keep
  // displaying a stale message after the user has moved on. Setup-required
  // states stay visible because they require user action.
  useEffect(() => {
    if (state !== "error") return;
    const timeout = window.setTimeout(() => {
      setState("idle");
      setError(null);
    }, 6000);
    return () => window.clearTimeout(timeout);
  }, [state, error]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    nativeRequestIdRef.current += 1;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    if (nativeProviderRef.current) {
      void cancelVoiceRecording(nativeProviderRef.current);
      nativeProviderRef.current = null;
    }
    finalTranscriptRef.current = "";
    setInterimTranscript("");
    setError(null);
    setActiveProvider(null);
    setState("idle");
  }, []);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(async () => {
    nativeRequestIdRef.current += 1;
    setError(null);
    setInterimTranscript("");
    setActiveProvider(null);
    finalTranscriptRef.current = "";
    cancelledRef.current = false;
    // Immediate UI feedback before any awaits — without this, the user
    // sees no change between clicking the mic and the OS permission
    // prompt appearing (cold-start CoreAudio + TCC verification can
    // take a couple of seconds on a fresh-signed build), and may
    // assume the click did nothing and click again.
    setState("starting");

    let providers: VoiceProviderInfo[];
    try {
      providers = await listVoiceProviders();
    } catch (err) {
      setError(String(err));
      setState("error");
      return;
    }

    const provider = chooseVoiceProvider(providers);
    setActiveProvider(provider);

    if (!provider) {
      const hasEnabledProvider = providers.some((candidate) => candidate.enabled);
      setError(
        hasEnabledProvider
          ? "No ready voice provider is available. Open Plugins settings to finish voice setup."
          : "No enabled voice provider is ready. Open Plugins settings to enable System dictation or set up an offline provider.",
      );
      setState("error");
      return;
    }

    if (isNativeVoiceProvider(provider)) {
      const providerMessage = provider.error ?? provider.statusLabel;
      if (provider.status === "engine-unavailable" || provider.status === "error") {
        setError(providerMessage);
        setState("error");
        return;
      }
      if (provider.setupRequired || provider.status !== "ready") {
        setError(providerMessage);
        setState("setup-required");
        onNeedsSetup(provider.id);
        return;
      }

      try {
        await startVoiceRecording(provider.id);
      } catch (err) {
        setError(String(err));
        setState("error");
        return;
      }

      nativeProviderRef.current = provider.id;
      setElapsedSeconds(0);
      setState("recording");
      return;
    }

    if (provider.id !== PLATFORM_VOICE_PROVIDER_ID) {
      setError(provider.error ?? provider.statusLabel ?? "This voice provider is not available.");
      setState("error");
      return;
    }

    if (!provider.enabled || provider.status !== "ready") {
      setError(provider.error ?? provider.statusLabel);
      setState("error");
      return;
    }

    if (platformSpeechDisabled) {
      setError("System dictation is disabled on macOS because it can crash the app before permission errors are recoverable.");
      setState("error");
      return;
    }

    if (!Recognition) {
      // Linux/Windows webviews typically don't expose the Web Speech API.
      // Rust reports the platform provider as "ready" because it has no
      // way to introspect webview capabilities, so we treat the missing
      // engine as setup-required here and route the user to Plugins
      // settings where they can enable the offline Whisper provider.
      setError(
        "System dictation isn't available in this webview. Switch to an offline voice provider in Plugins settings.",
      );
      setState("setup-required");
      onNeedsSetup(provider.id);
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onstart = () => {
      setElapsedSeconds(0);
      setState("recording");
    };
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results.item(index);
        const transcript = result.length > 0 ? result.item(0).transcript : "";
        if (result.isFinal) finalTranscriptRef.current += transcript;
        else interim += transcript;
      }
      setInterimTranscript(interim.trim());
    };
    recognition.onerror = (event) => {
      if (cancelledRef.current) return;
      setError(describeSpeechRecognitionError(event));
      setState("error");
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      if (cancelledRef.current) return;
      setState("transcribing");
      const transcript = finalTranscriptRef.current.trim();
      finalTranscriptRef.current = "";
      setInterimTranscript("");
      if (transcript) onTranscript(transcript);
      setState("idle");
    };
    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      recognitionRef.current = null;
      setError(String(err));
      setState("error");
    }
  }, [Recognition, onNeedsSetup, onTranscript]);

  const stop = useCallback(() => {
    if (nativeProviderRef.current) {
      const providerId = nativeProviderRef.current;
      nativeProviderRef.current = null;
      const requestId = nativeRequestIdRef.current + 1;
      nativeRequestIdRef.current = requestId;
      setState("transcribing");
      void stopAndTranscribeVoice(providerId)
        .then((transcript) => {
          if (
            cancelledRef.current ||
            nativeRequestIdRef.current !== requestId
          ) {
            return;
          }
          const normalized = transcript.trim();
          if (normalized) onTranscript(normalized);
          setState("idle");
        })
        .catch((err) => {
          if (
            cancelledRef.current ||
            nativeRequestIdRef.current !== requestId
          ) {
            return;
          }
          setError(String(err));
          setState("error");
        });
      return;
    }

    if (!recognitionRef.current) return;
    setState("transcribing");
    recognitionRef.current.stop();
  }, [onTranscript]);

  // Stop any active recording when the window loses focus, regardless of how
  // it was started (mic button, toggle hotkey, hold-to-talk). Without this,
  // a Cmd+Tab away from the app would leave the mic hot in the background.
  // stop() is internally gated — it's a no-op when no recording is in flight.
  useEffect(() => {
    const onBlur = () => stop();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [stop]);

  return {
    state,
    elapsedSeconds,
    interimTranscript,
    error,
    activeProvider,
    webSpeechSupported,
    start,
    stop,
    cancel,
  };
}
