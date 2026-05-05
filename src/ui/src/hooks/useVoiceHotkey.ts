import { useEffect, useLayoutEffect, useRef } from "react";
import type { VoiceInputController } from "./useVoiceInput";

export const DEFAULT_TOGGLE_HOTKEY = "mod+shift+m";
export const DEFAULT_HOLD_HOTKEY = "AltRight";

type VoiceHandle = Pick<VoiceInputController, "state" | "start" | "stop" | "cancel">;

/** Check if a keyboard event matches a stored toggle combo like "mod+shift+m". */
export function matchesToggle(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  if (!key || e.key.toLowerCase() !== key) return false;
  const wantsMod = parts.includes("mod");
  const wantsShift = parts.includes("shift");
  const wantsAlt = parts.includes("alt");
  const hasMod = e.metaKey || e.ctrlKey;
  return wantsMod === hasMod && wantsShift === e.shiftKey && wantsAlt === e.altKey;
}

/** Human-readable display of a toggle hotkey string (e.g. "mod+shift+m" → "⌘⇧M"). */
export function formatToggleHotkey(hotkey: string | null, isMac: boolean): string {
  if (!hotkey) return "—";
  return hotkey
    .split("+")
    .map((part) => {
      switch (part.toLowerCase()) {
        case "mod": return isMac ? "⌘" : "Ctrl";
        case "meta": return "⌘";
        case "ctrl": return "Ctrl";
        case "shift": return isMac ? "⇧" : "Shift";
        case "alt": return isMac ? "⌥" : "Alt";
        default: return part.toUpperCase();
      }
    })
    .join(isMac ? "" : "+");
}

/** Human-readable display of a hold key code (e.g. "AltRight" → "Right ⌥"). */
export function formatHoldHotkey(code: string | null, isMac: boolean): string {
  if (!code) return "—";
  const map: Record<string, { mac: string; other: string }> = {
    AltRight: { mac: "Right ⌥", other: "Right Alt" },
    AltLeft: { mac: "Left ⌥", other: "Left Alt" },
    ControlRight: { mac: "Right ⌃", other: "Right Ctrl" },
    ControlLeft: { mac: "Left ⌃", other: "Left Ctrl" },
    ShiftRight: { mac: "Right ⇧", other: "Right Shift" },
    ShiftLeft: { mac: "Left ⇧", other: "Left Shift" },
    MetaRight: { mac: "Right ⌘", other: "Right Meta" },
    MetaLeft: { mac: "Left ⌘", other: "Left Meta" },
    Space: { mac: "Space", other: "Space" },
    F13: { mac: "F13", other: "F13" },
    F14: { mac: "F14", other: "F14" },
    F15: { mac: "F15", other: "F15" },
  };
  const entry = map[code];
  if (entry) return isMac ? entry.mac : entry.other;
  return code.replace(/^(?:Key|Digit)/, "");
}

/**
 * Factory that produces the raw event handlers for the voice hotkey state machine.
 * Exported so tests can exercise the logic without mounting a React component.
 *
 * The hold-to-talk state is tracked in a closure variable shared across the
 * three returned handlers, so they must all be created together and used as a set.
 */
export function createVoiceHotkeyHandlers(
  getVoice: () => VoiceHandle,
  toggleHotkey: string | null,
  holdHotkey: string | null,
): {
  onKeyDown: (e: KeyboardEvent) => void;
  onKeyUp: (e: KeyboardEvent) => void;
  onBlur: () => void;
} {
  let holdActive = false;

  return {
    onKeyDown(e: KeyboardEvent) {
      // Suppress repeated hold-key events so the OS key-repeat doesn't
      // re-trigger start(). The !e.repeat guard on the hold branch below
      // already handles this, but we also preventDefault so the webview
      // doesn't receive spurious Alt/Option characters while holding.
      if (e.repeat) {
        if (holdHotkey && e.code === holdHotkey && holdActive) e.preventDefault();
        return;
      }

      const v = getVoice();

      if (toggleHotkey && matchesToggle(e, toggleHotkey)) {
        e.preventDefault();
        if (v.state === "recording") {
          v.stop();
        } else if (v.state === "starting" || v.state === "transcribing") {
          v.cancel();
        } else if (v.state === "idle") {
          void v.start();
        }
        return;
      }

      if (holdHotkey && e.code === holdHotkey && !holdActive && v.state === "idle") {
        e.preventDefault();
        holdActive = true;
        void v.start();
      }
    },

    onKeyUp(e: KeyboardEvent) {
      if (!holdHotkey || !holdActive || e.code !== holdHotkey) return;
      holdActive = false;
      const v = getVoice();
      if (v.state === "recording" || v.state === "starting") {
        v.stop();
      }
    },

    // Window blur (e.g. Cmd+Tab to another app while holding the key) must
    // be treated as a key release so the recording doesn't get stuck on.
    onBlur() {
      if (!holdActive) return;
      holdActive = false;
      const v = getVoice();
      if (v.state === "recording" || v.state === "starting") {
        v.stop();
      }
    },
  };
}

/**
 * Registers global keyboard shortcuts for voice input:
 * - Toggle hotkey (default Cmd/Ctrl+Shift+M): start/stop recording.
 * - Hold hotkey (default Right Alt/Option): hold to record, release to transcribe.
 *
 * Listeners are re-registered only when the hotkey config changes, not on
 * every voice state update (voice state is read via a ref at handler time).
 */
export function useVoiceHotkey(
  voice: VoiceInputController,
  toggleHotkey: string | null,
  holdHotkey: string | null,
): void {
  const voiceRef = useRef<VoiceInputController>(voice);

  // Keep the ref in sync after every render so event handlers always read
  // the latest voice state without being re-registered on every state change.
  // useLayoutEffect (not render-time assignment) satisfies the React Compiler's
  // requirement that refs are only mutated outside of render.
  useLayoutEffect(() => {
    voiceRef.current = voice;
  });

  useEffect(() => {
    const { onKeyDown, onKeyUp, onBlur } = createVoiceHotkeyHandlers(
      () => voiceRef.current,
      toggleHotkey,
      holdHotkey,
    );
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [toggleHotkey, holdHotkey]);
}
