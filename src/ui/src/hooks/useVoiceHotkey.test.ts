import { describe, expect, it, vi } from "vitest";
import {
  createVoiceHotkeyHandlers,
  matchesToggle,
  normalizeToggleKey,
} from "./useVoiceHotkey";
import type { VoiceInputController } from "./useVoiceInput";

type VoiceState = VoiceInputController["state"];

function makeVoice(initial: VoiceState = "idle") {
  let state = initial;
  return {
    get state(): VoiceState {
      return state;
    },
    set state(next: VoiceState) {
      state = next;
    },
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => void>(),
    cancel: vi.fn<() => void>(),
    elapsedSeconds: 0,
    interimTranscript: "",
    error: null,
    activeProvider: null,
    webSpeechSupported: false,
  };
}

function keyEvent(
  overrides: Partial<{
    key: string;
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    repeat: boolean;
    getModifierState: (m: string) => boolean;
  }>,
): KeyboardEvent {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    getModifierState: () => false,
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe("matchesToggle", () => {
  it("matches mod+shift+m with Cmd+Shift+M (Mac)", () => {
    expect(
      matchesToggle(keyEvent({ key: "m", metaKey: true, shiftKey: true }), "mod+shift+m"),
    ).toBe(true);
  });

  it("matches mod+shift+m with Ctrl+Shift+M (Windows/Linux)", () => {
    expect(
      matchesToggle(keyEvent({ key: "m", ctrlKey: true, shiftKey: true }), "mod+shift+m"),
    ).toBe(true);
  });

  it("rejects when shift is missing", () => {
    expect(matchesToggle(keyEvent({ key: "m", metaKey: true }), "mod+shift+m")).toBe(false);
  });

  it("rejects when mod is missing", () => {
    expect(matchesToggle(keyEvent({ key: "m", shiftKey: true }), "mod+shift+m")).toBe(false);
  });

  it("rejects wrong key", () => {
    expect(
      matchesToggle(keyEvent({ key: "n", metaKey: true, shiftKey: true }), "mod+shift+m"),
    ).toBe(false);
  });

  it("matches mod+shift+plus against the literal '+' key", () => {
    expect(
      matchesToggle(keyEvent({ key: "+", metaKey: true, shiftKey: true }), "mod+shift+plus"),
    ).toBe(true);
  });

  it("rejects when alt is held but not required", () => {
    expect(
      matchesToggle(
        keyEvent({ key: "m", metaKey: true, shiftKey: true, altKey: true }),
        "mod+shift+m",
      ),
    ).toBe(false);
  });
});

describe("createVoiceHotkeyHandlers — toggle", () => {
  it("starts recording when idle and toggle key is pressed", () => {
    const voice = makeVoice("idle");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, "mod+shift+m", null);
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true }));
    expect(voice.start).toHaveBeenCalledOnce();
  });

  it("stops recording when already recording", () => {
    const voice = makeVoice("recording");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, "mod+shift+m", null);
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true }));
    expect(voice.stop).toHaveBeenCalledOnce();
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("cancels when in starting state", () => {
    const voice = makeVoice("starting");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, "mod+shift+m", null);
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true }));
    expect(voice.cancel).toHaveBeenCalledOnce();
  });

  it("starts from setup-required (post-permission-grant recovery)", () => {
    // Repro for the bug where hotkey did nothing after the user granted TCC
    // perms — the controller was sitting in setup-required and only the mic
    // button's catchall onClick would re-attempt start().
    const voice = makeVoice("setup-required");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, "mod+shift+m", null);
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true }));
    expect(voice.start).toHaveBeenCalledOnce();
  });

  it("starts from error state (clears error and retries)", () => {
    const voice = makeVoice("error");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, "mod+shift+m", null);
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true }));
    expect(voice.start).toHaveBeenCalledOnce();
  });

  it("cancels when transcribing", () => {
    const voice = makeVoice("transcribing");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, "mod+shift+m", null);
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true }));
    expect(voice.cancel).toHaveBeenCalledOnce();
  });

  it("ignores OS-repeat keydown events", () => {
    const voice = makeVoice("idle");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, "mod+shift+m", null);
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true, repeat: true }));
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("preventDefaults repeat events that match the toggle (no-modifier rebind)", () => {
    const voice = makeVoice("recording");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, "a", null);
    const e = keyEvent({ key: "a", repeat: true });
    onKeyDown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(voice.stop).not.toHaveBeenCalled();
  });
});

describe("normalizeToggleKey", () => {
  it("maps '+' to 'plus' to avoid delimiter collision", () => {
    expect(normalizeToggleKey("+")).toBe("plus");
  });

  it("lowercases everything else", () => {
    expect(normalizeToggleKey("M")).toBe("m");
    expect(normalizeToggleKey("Enter")).toBe("enter");
  });

  it("does nothing when toggle hotkey is null", () => {
    const voice = makeVoice("idle");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, null, null);
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true }));
    expect(voice.start).not.toHaveBeenCalled();
  });
});

describe("createVoiceHotkeyHandlers — hold-to-talk", () => {
  it("starts recording on keydown and stops on keyup", () => {
    const voice = makeVoice("idle");
    const { onKeyDown, onKeyUp } = createVoiceHotkeyHandlers(
      () => voice,
      null,
      "AltRight",
    );

    onKeyDown(keyEvent({ code: "AltRight" }));
    expect(voice.start).toHaveBeenCalledOnce();

    voice.state = "recording";
    onKeyUp(keyEvent({ code: "AltRight" }));
    expect(voice.stop).toHaveBeenCalledOnce();
  });

  it("supports code-prefixed hold bindings", () => {
    const voice = makeVoice("idle");
    const { onKeyDown, onKeyUp } = createVoiceHotkeyHandlers(
      () => voice,
      null,
      "code:AltRight",
    );

    onKeyDown(keyEvent({ code: "AltRight" }));
    expect(voice.start).toHaveBeenCalledOnce();

    voice.state = "recording";
    onKeyUp(keyEvent({ code: "AltRight" }));
    expect(voice.stop).toHaveBeenCalledOnce();
  });

  it("supports modifier-inclusive hold bindings", () => {
    const voice = makeVoice("idle");
    const { onKeyDown, onKeyUp } = createVoiceHotkeyHandlers(
      () => voice,
      null,
      "shift+code:AltRight",
    );

    onKeyDown(keyEvent({ code: "AltRight" }));
    expect(voice.start).not.toHaveBeenCalled();

    onKeyDown(keyEvent({ code: "AltRight", shiftKey: true }));
    expect(voice.start).toHaveBeenCalledOnce();

    voice.state = "recording";
    onKeyUp(keyEvent({ code: "AltRight" }));
    expect(voice.stop).toHaveBeenCalledOnce();
  });

  it("clears holdActive on blur so a late keyup is a no-op", () => {
    // useVoiceInput owns the actual stop-on-blur (so it applies to recordings
    // started by mic button or toggle hotkey too). The hotkey's onBlur job is
    // narrower: clear the closure-local holdActive so a stale keyup arriving
    // later doesn't trigger spurious behavior.
    const voice = makeVoice("idle");
    const { onKeyDown, onKeyUp, onBlur } = createVoiceHotkeyHandlers(
      () => voice,
      null,
      "AltRight",
    );

    onKeyDown(keyEvent({ code: "AltRight" }));
    voice.state = "recording";
    onBlur();
    voice.state = "idle";
    onKeyUp(keyEvent({ code: "AltRight" }));

    // No stop fired by the hotkey path — useVoiceInput handles that centrally.
    expect(voice.stop).not.toHaveBeenCalled();
  });

  it("ignores OS-repeat keydowns after initial press", () => {
    const voice = makeVoice("idle");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, null, "AltRight");

    onKeyDown(keyEvent({ code: "AltRight" })); // initial
    voice.state = "starting";
    onKeyDown(keyEvent({ code: "AltRight", repeat: true })); // OS repeat
    onKeyDown(keyEvent({ code: "AltRight", repeat: true })); // OS repeat

    expect(voice.start).toHaveBeenCalledOnce();
  });

  it("a fresh hold cycle works after a blur cleared holdActive", () => {
    // After blur clears holdActive, the next physical press should start
    // a new recording cleanly (rather than being blocked by a stale flag).
    const voice = makeVoice("idle");
    const { onKeyDown, onBlur } = createVoiceHotkeyHandlers(
      () => voice,
      null,
      "AltRight",
    );

    onKeyDown(keyEvent({ code: "AltRight" }));
    voice.state = "recording";
    onBlur(); // clears holdActive (but useVoiceInput stops the recording)
    voice.state = "idle";

    onKeyDown(keyEvent({ code: "AltRight" })); // fresh press
    expect(voice.start).toHaveBeenCalledTimes(2);
  });

  it("does not start hold when voice is recording/starting/transcribing", () => {
    for (const state of ["recording", "starting", "transcribing"] as const) {
      const voice = makeVoice(state);
      const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, null, "AltRight");
      onKeyDown(keyEvent({ code: "AltRight" }));
      expect(voice.start, `state=${state}`).not.toHaveBeenCalled();
    }
  });

  it("starts hold from setup-required (post-permission-grant recovery)", () => {
    const voice = makeVoice("setup-required");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, null, "AltRight");
    onKeyDown(keyEvent({ code: "AltRight" }));
    expect(voice.start).toHaveBeenCalledOnce();
  });

  it("starts hold from error state", () => {
    const voice = makeVoice("error");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, null, "AltRight");
    onKeyDown(keyEvent({ code: "AltRight" }));
    expect(voice.start).toHaveBeenCalledOnce();
  });

  it("does not stop on keyup for a different key code", () => {
    const voice = makeVoice("idle");
    const { onKeyDown, onKeyUp } = createVoiceHotkeyHandlers(
      () => voice,
      null,
      "AltRight",
    );

    onKeyDown(keyEvent({ code: "AltRight" }));
    voice.state = "recording";
    onKeyUp(keyEvent({ code: "AltLeft" })); // different key
    expect(voice.stop).not.toHaveBeenCalled();

    onKeyUp(keyEvent({ code: "AltRight" })); // correct key
    expect(voice.stop).toHaveBeenCalledOnce();
  });

  it("ignores AltGr presses (Right Alt on non-US layouts)", () => {
    // AltGr fires e.key === "AltGraph" on most browsers, sometimes also as
    // ctrlKey+altKey, sometimes only as a modifier-state flag. All forms
    // must be ignored so typing @ / {} on a German/French/Spanish layout
    // doesn't start voice recording.
    const voice = makeVoice("idle");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, null, "AltRight");

    onKeyDown(keyEvent({ code: "AltRight", key: "AltGraph" }));
    expect(voice.start).not.toHaveBeenCalled();

    onKeyDown(keyEvent({ code: "AltRight", ctrlKey: true, altKey: true }));
    expect(voice.start).not.toHaveBeenCalled();

    onKeyDown(keyEvent({
      code: "AltRight",
      getModifierState: (m) => m === "AltGraph",
    }));
    expect(voice.start).not.toHaveBeenCalled();
  });
});

describe("createVoiceHotkeyHandlers — input blocked gate", () => {
  it("blocks toggle from starting recording when an overlay is open", () => {
    const voice = makeVoice("idle");
    const { onKeyDown } = createVoiceHotkeyHandlers(
      () => voice,
      "mod+shift+m",
      null,
      () => true, // overlay open
    );
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true }));
    expect(voice.start).not.toHaveBeenCalled();
  });

  it("still allows toggle to STOP an in-flight recording when overlay is open", () => {
    // If user opens settings while recording, the hotkey must still be able
    // to end the recording — otherwise it gets stuck on.
    const voice = makeVoice("recording");
    const { onKeyDown } = createVoiceHotkeyHandlers(
      () => voice,
      "mod+shift+m",
      null,
      () => true,
    );
    onKeyDown(keyEvent({ key: "m", metaKey: true, shiftKey: true }));
    expect(voice.stop).toHaveBeenCalledOnce();
  });

  it("blocks hold from starting when overlay is open", () => {
    const voice = makeVoice("idle");
    const { onKeyDown } = createVoiceHotkeyHandlers(
      () => voice,
      null,
      "AltRight",
      () => true,
    );
    onKeyDown(keyEvent({ code: "AltRight" }));
    expect(voice.start).not.toHaveBeenCalled();
  });
});
