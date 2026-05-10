import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";

// Tests for the missing-CLI auto-open / dismissal flow.
//
// Background: the Tauri backend emits `missing-dependency` whenever it
// catches the `MISSING_CLI:<tool>` sentinel from a spawn site. The
// frontend listener calls `reportMissingCli(payload)` which decides
// whether to auto-open the install-guidance modal.
//
// The decision is per-tool and dismissal-aware:
//
//   - First event for a tool → cache + auto-open modal so non-chat
//     surfaces (auth, repository, SCM, plugin-settings) keep their
//     direct-modal UX.
//   - User dismisses (closeModal while `activeModal === "missingCli"`)
//     → tool added to dismissed list.
//   - Subsequent events for that tool → cache only, modal stays closed
//     (avoids the "modal pops on every chat-send retry" antipattern).
//   - User clicks the inline link (`openMissingCliModal()`) → modal
//     opens AND the dismissal is cleared, so the explicit-user-action
//     path always works regardless of prior state.

const claudePayload = {
  tool: "claude",
  display_name: "Claude CLI",
  purpose: "Claudette runs the claude CLI as a subprocess.",
  platform: "macos",
  install_options: [],
};
const ghPayload = {
  tool: "gh",
  display_name: "GitHub CLI",
  purpose: "GitHub plugin needs gh.",
  platform: "macos",
  install_options: [],
};

describe("missing-cli reporting and dismissal", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeModal: null,
      modalData: {},
      lastMissingCli: null,
      missingCliDismissedTools: [],
    });
  });

  it("auto-opens the modal on the first event for a tool", () => {
    useAppStore.getState().reportMissingCli(claudePayload);
    const s = useAppStore.getState();
    expect(s.activeModal).toBe("missingCli");
    expect(s.modalData).toEqual(claudePayload);
    expect(s.lastMissingCli).toEqual(claudePayload);
    // Nothing dismissed yet.
    expect(s.missingCliDismissedTools).toEqual([]);
  });

  it("records dismissal when closeModal closes the missing-CLI modal", () => {
    useAppStore.getState().reportMissingCli(claudePayload);
    useAppStore.getState().closeModal();
    const s = useAppStore.getState();
    expect(s.activeModal).toBeNull();
    expect(s.missingCliDismissedTools).toEqual(["claude"]);
  });

  it("does NOT record dismissal when closeModal closes a different modal", () => {
    useAppStore.setState({ activeModal: "settings", modalData: {} });
    useAppStore.getState().closeModal();
    expect(useAppStore.getState().missingCliDismissedTools).toEqual([]);
  });

  it("suppresses auto-open after dismissal but still refreshes the cache", () => {
    useAppStore.getState().reportMissingCli(claudePayload);
    useAppStore.getState().closeModal();
    // A second event for the same tool — modal must stay closed.
    const newPayload = { ...claudePayload, purpose: "updated copy" };
    useAppStore.getState().reportMissingCli(newPayload);
    const s = useAppStore.getState();
    expect(s.activeModal).toBeNull();
    // Cache is still updated so an explicit reopen renders the latest copy.
    expect(s.lastMissingCli).toEqual(newPayload);
  });

  it("auto-opens for a different tool even when another tool is dismissed", () => {
    // Dismiss claude.
    useAppStore.getState().reportMissingCli(claudePayload);
    useAppStore.getState().closeModal();
    // gh comes in fresh — should still auto-open.
    useAppStore.getState().reportMissingCli(ghPayload);
    const s = useAppStore.getState();
    expect(s.activeModal).toBe("missingCli");
    expect(s.modalData).toEqual(ghPayload);
    // claude stays dismissed; gh isn't dismissed yet.
    expect(s.missingCliDismissedTools).toEqual(["claude"]);
  });

  it("openMissingCliModal opens with cached guidance and clears that tool's dismissal", () => {
    useAppStore.getState().reportMissingCli(claudePayload);
    useAppStore.getState().closeModal();
    // User clicks "View install options →".
    useAppStore.getState().openMissingCliModal();
    const s = useAppStore.getState();
    expect(s.activeModal).toBe("missingCli");
    expect(s.modalData).toEqual(claudePayload);
    expect(s.missingCliDismissedTools).toEqual([]);
  });

  it("openMissingCliModal is a no-op when no guidance has been cached", () => {
    useAppStore.getState().openMissingCliModal();
    expect(useAppStore.getState().activeModal).toBeNull();
  });

  it("does not duplicate dismissal entries when closing twice for the same tool", () => {
    useAppStore.getState().reportMissingCli(claudePayload);
    useAppStore.getState().closeModal();
    // Re-open via explicit action (clears dismissal), then dismiss again.
    useAppStore.getState().openMissingCliModal();
    useAppStore.getState().closeModal();
    expect(useAppStore.getState().missingCliDismissedTools).toEqual(["claude"]);
  });
});
