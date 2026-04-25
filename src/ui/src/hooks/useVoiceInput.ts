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
  platformSupported: boolean;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
}

export function useVoiceInput(
  onTranscript: (transcript: string) => void,
  onNeedsSetup: () => void,
): VoiceInputController {
  const [state, setState] = useState<VoiceState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<VoiceProviderInfo | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const nativeProviderRef = useRef<string | null>(null);
  const finalTranscriptRef = useRef("");
  const cancelledRef = useRef(false);
  const platformSpeechDisabled = useMemo(() => isMacPlatform(), []);

  const Recognition = useMemo(() => {
    if (platformSpeechDisabled) return undefined;
    if (typeof window === "undefined") return undefined;
    const speechWindow = window as SpeechRecognitionWindow;
    return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  }, [platformSpeechDisabled]);

  const platformSupported = Boolean(Recognition) && !platformSpeechDisabled;

  useEffect(() => {
    if (state !== "recording") return;
    const started = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => window.clearInterval(interval);
  }, [state]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    if (nativeProviderRef.current) {
      void cancelVoiceRecording(nativeProviderRef.current);
      nativeProviderRef.current = null;
    }
    finalTranscriptRef.current = "";
    setInterimTranscript("");
    setState("idle");
  }, []);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(async () => {
    setError(null);
    setInterimTranscript("");
    finalTranscriptRef.current = "";
    cancelledRef.current = false;

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
      setError("No enabled voice provider is ready. Open Plugins settings to enable System dictation or set up an offline provider.");
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
        onNeedsSetup();
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
      setError("System dictation is not available in this webview.");
      setState("error");
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
      setState("transcribing");
      void stopAndTranscribeVoice(providerId)
        .then((transcript) => {
          if (cancelledRef.current) return;
          const normalized = transcript.trim();
          if (normalized) onTranscript(normalized);
          setState("idle");
        })
        .catch((err) => {
          if (cancelledRef.current) return;
          setError(String(err));
          setState("error");
        });
      return;
    }

    if (!recognitionRef.current) return;
    setState("transcribing");
    recognitionRef.current.stop();
  }, [onTranscript]);

  return {
    state,
    elapsedSeconds,
    interimTranscript,
    error,
    activeProvider,
    platformSupported,
    start,
    stop,
    cancel,
  };
}
