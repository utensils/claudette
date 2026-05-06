import type { Participant } from "../../stores/slices/collabSlice";
import type { ChatMessage } from "../../types/chat";

export function userMessageAuthorLabel(
  msg: Pick<ChatMessage, "author_participant_id" | "author_display_name">,
  selfParticipantId: string | null,
  participants: Participant[],
  youLabel: string,
  userLabel = "User",
): string {
  const participantNameById = new Map(
    participants.map((p) => [p.id, p.display_name]),
  );

  if (msg.author_participant_id != null) {
    if (msg.author_participant_id === selfParticipantId) {
      return youLabel;
    }
    return (
      msg.author_display_name ??
      participantNameById.get(msg.author_participant_id) ??
      userLabel
    );
  }

  const host = participants.find((p) => p.is_host);
  if (host && selfParticipantId !== host.id) {
    return host.display_name;
  }

  return youLabel;
}
