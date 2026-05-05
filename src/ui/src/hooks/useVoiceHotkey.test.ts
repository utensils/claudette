import { describe, expect, it, vi } from "vitest";
import { createVoiceHotkeyHandlers, matchesToggle } from "./useVoiceHotkey";
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

  it("stops recording on window blur during hold (critical edge case)", () => {
    const voice = makeVoice("idle");
    const { onKeyDown, onBlur } = createVoiceHotkeyHandlers(
      () => voice,
      null,
      "AltRight",
    );

    onKeyDown(keyEvent({ code: "AltRight" }));
    voice.state = "recording";

    onBlur(); // window loses focus mid-hold
    expect(voice.stop).toHaveBeenCalledOnce();
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

  it("late keyup after blur does not double-stop", () => {
    const voice = makeVoice("idle");
    const { onKeyDown, onKeyUp, onBlur } = createVoiceHotkeyHandlers(
      () => voice,
      null,
      "AltRight",
    );

    onKeyDown(keyEvent({ code: "AltRight" }));
    voice.state = "recording";
    onBlur(); // clears holdActive
    voice.state = "idle";
    onKeyUp(keyEvent({ code: "AltRight" })); // arrives after blur already fired

    // stop() should only have been called once (by blur)
    expect(voice.stop).toHaveBeenCalledOnce();
  });

  it("does not start hold when voice is not idle", () => {
    const voice = makeVoice("transcribing");
    const { onKeyDown } = createVoiceHotkeyHandlers(() => voice, null, "AltRight");
    onKeyDown(keyEvent({ code: "AltRight" }));
    expect(voice.start).not.toHaveBeenCalled();
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
});
