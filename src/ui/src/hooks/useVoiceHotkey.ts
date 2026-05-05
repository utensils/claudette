import { useEffect, useLayoutEffect, useRef } from "react";
import { useAppStore } from "../stores/useAppStore";
import type { VoiceInputController } from "./useVoiceInput";

// Re-export so existing call sites (KeyboardSettings, tests) keep working.
export {
  DEFAULT_TOGGLE_HOTKEY,
  DEFAULT_HOLD_HOTKEY_MAC,
  getDefaultHoldHotkey,
} from "../utils/voiceHotkeys";

/** Detect AltGr — Right Alt on most non-US layouts produces this and is used
 * to type common characters. We must never treat AltGr presses as hotkey
 * activations. */
function isAltGr(e: KeyboardEvent): boolean {
  if (e.key === "AltGraph") return true;
  // Some browsers/OSes report AltGr as Ctrl+Alt with code AltRight.
  if (typeof e.getModifierState === "function" && e.getModifierState("AltGraph")) return true;
  return e.code === "AltRight" && e.ctrlKey && e.altKey;
}

type VoiceHandle = Pick<VoiceInputController, "state" | "start" | "stop" | "cancel">;

/** Normalize a key name for use in the `+`-delimited combo format.
 * "+" itself becomes "plus" so the serialized combo stays unambiguous
 * (otherwise "mod+shift+" + "+" would split into a stray empty segment). */
export function normalizeToggleKey(key: string): string {
  if (key === "+") return "plus";
  return key.toLowerCase();
}

/** Check if a keyboard event matches a stored toggle combo like "mod+shift+m". */
export function matchesToggle(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  if (!key || normalizeToggleKey(e.key) !== key) return false;
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
        case "plus": return "+";
        default: return part.toUpperCase();
      }
    })
    .join(isMac ? "" : "+");
}

const HOLD_KEY_DISPLAY: Record<string, { mac: string; other: string }> = {
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

/** Human-readable display of a hold key code (e.g. "AltRight" → "Right ⌥"). */
export function formatHoldHotkey(code: string | null, isMac: boolean): string {
  if (!code) return "—";
  const entry = HOLD_KEY_DISPLAY[code];
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
  /** Returns true when the hotkey should not fire START actions (e.g. a modal
   * or settings panel is open). Stop/cancel/release actions still run so an
   * in-flight recording can always be ended. */
  isInputBlocked: () => boolean = () => false,
): {
  onKeyDown: (e: KeyboardEvent) => void;
  onKeyUp: (e: KeyboardEvent) => void;
  onBlur: () => void;
} {
  let holdActive = false;

  return {
    onKeyDown(e: KeyboardEvent) {
      // Suppress repeated keydowns. Toggle and hold-to-talk both fire once per
      // physical press, so OS key-repeat events should be eaten — otherwise
      // a printable toggle binding (e.g. user rebinds to a single letter)
      // would leak repeated characters into the focused input on hold.
      if (e.repeat) {
        if (holdHotkey && e.code === holdHotkey && holdActive) e.preventDefault();
        if (toggleHotkey && matchesToggle(e, toggleHotkey)) e.preventDefault();
        return;
      }

      const v = getVoice();

      if (toggleHotkey && matchesToggle(e, toggleHotkey)) {
        e.preventDefault();
        if (v.state === "recording") {
          v.stop();
        } else if (v.state === "starting" || v.state === "transcribing") {
          v.cancel();
        } else if (!isInputBlocked()) {
          // idle, setup-required, or error — try start (only when no overlay
          // owns input focus). Mirrors the mic button's catchall: from
          // setup-required, start() re-runs the provider check (now
          // succeeding after the user granted perms); from error it clears
          // the error and re-attempts.
          void v.start();
        }
        return;
      }

      // Reject AltGr presses outright — Right Alt acts as AltGr on most
      // non-US layouts and is used to type @, {}, ñ, ç, etc. Triggering
      // hold-to-talk on those would break normal text entry.
      if (holdHotkey && e.code === holdHotkey && isAltGr(e)) return;

      if (
        holdHotkey &&
        e.code === holdHotkey &&
        !holdActive &&
        v.state !== "recording" &&
        v.state !== "starting" &&
        v.state !== "transcribing" &&
        !isInputBlocked()
      ) {
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

    // Window blur (e.g. Cmd+Tab away while holding the key): clear the
    // hold-state flag so a stale keyup arriving later is a no-op. The
    // actual recording stop is handled centrally by useVoiceInput so it
    // applies regardless of how the recording was started (mic button,
    // toggle hotkey, hold-to-talk).
    onBlur() {
      holdActive = false;
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
    // Block START actions when an overlay owns input focus — same gating
    // pattern as useKeyboardShortcuts.ts. Stop/cancel/release are never
    // gated, so an in-flight recording can always be ended.
    const isInputBlocked = () => {
      const s = useAppStore.getState();
      return s.settingsOpen || !!s.activeModal || s.commandPaletteOpen || s.fuzzyFinderOpen;
    };
    const { onKeyDown, onKeyUp, onBlur } = createVoiceHotkeyHandlers(
      () => voiceRef.current,
      toggleHotkey,
      holdHotkey,
      isInputBlocked,
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
