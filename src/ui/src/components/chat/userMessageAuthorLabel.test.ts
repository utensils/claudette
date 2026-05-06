import { describe, expect, it } from "vitest";
import { userMessageAuthorLabel } from "./userMessageAuthorLabel";
import type { Participant } from "../../stores/slices/collabSlice";

const host: Participant = {
  id: "host",
  display_name: "halcyon",
  is_host: true,
  joined_at: 1,
  muted: false,
};

const guest: Participant = {
  id: "guest-pid",
  display_name: "bender",
  is_host: false,
  joined_at: 2,
  muted: false,
};

describe("userMessageAuthorLabel", () => {
  it("labels the local participant as You", () => {
    expect(userMessageAuthorLabel({
      author_participant_id: "guest-pid",
      author_display_name: "bender",
    }, "guest-pid", [host, guest], "You")).toBe("You");
  });

  it("labels a stamped host message by host display name on a remote client", () => {
    expect(userMessageAuthorLabel({
      author_participant_id: "host",
      author_display_name: null,
    }, "guest-pid", [host, guest], "You")).toBe("halcyon");
  });

  it("uses a neutral fallback for an unknown stamped non-self participant", () => {
    expect(userMessageAuthorLabel({
      author_participant_id: "missing-pid",
      author_display_name: null,
    }, "guest-pid", [host, guest], "You", "User")).toBe("User");
  });

  it("labels an unstamped user message as host on a remote collaborative client", () => {
    expect(userMessageAuthorLabel({
      author_participant_id: null,
      author_display_name: null,
    }, "guest-pid", [host, guest], "You")).toBe("halcyon");
  });

  it("keeps unstamped local host messages labeled as You", () => {
    expect(userMessageAuthorLabel({
      author_participant_id: null,
      author_display_name: null,
    }, "host", [host, guest], "You")).toBe("You");
  });
});
