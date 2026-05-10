import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Crown, MicOff, MoreHorizontal, UserMinus, Users } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { kickParticipant, muteParticipant } from "../../services/tauri";

/**
 * Per-session participant roster. No-ops to a hidden div when there are no
 * participants — solo sessions stay visually unchanged, collaborative
 * sessions show one chip per connected user.
 *
 * Only the host sees the moderation popover (kick / mute). Determined by
 * the backend stamping `is_host` on each `ParticipantInfo`; remote clients
 * receive the same broadcast event so they see the roster but no host
 * controls (the Rust handler also rejects host-only RPCs server-side, so
 * the client gate is a UX hint, not a security boundary).
 *
 * `selfParticipantId` tells the roster which entry is "you" — the host
 * sentinel for local workspaces, or the remote-issued participant id for
 * paired remote workspaces. Without it, remote UIs would never
 * highlight their own chip.
 */
export function ParticipantsRoster({
  sessionId,
  selfParticipantId,
}: {
  sessionId: string;
  selfParticipantId: string | null;
}) {
  const { t } = useTranslation("chat");
  const participants = useAppStore((s) => s.participants[sessionId]);
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);

  if (!participants || participants.length === 0) {
    return null;
  }

  // We're the host iff we recognize ourselves as the host sentinel and that
  // sentinel is in the participant list. Remote UIs never see "host" as
  // their selfParticipantId, so this stays false for them.
  const localIsHost =
    selfParticipantId === "host" &&
    participants.some((p) => p.is_host && p.id === "host");

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 6px",
      }}
      title={t("participants_connected", { count: participants.length })}
    >
      <Users size={12} style={{ opacity: 0.6 }} />
      {participants.map((p) => {
        const isSelf = selfParticipantId !== null && p.id === selfParticipantId;
        const showMenu =
          localIsHost && !p.is_host && openMenuFor === p.id;
        return (
          <div
            key={p.id}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 2,
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 10,
              background: isSelf
                ? "rgba(var(--accent-primary-rgb), 0.15)"
                : "var(--chat-user-bg)",
              opacity: p.muted ? 0.5 : 1,
            }}
          >
            {p.is_host && <Crown size={10} style={{ opacity: 0.7 }} />}
            {p.muted && <MicOff size={10} style={{ opacity: 0.7 }} />}
            <span>{p.display_name}</span>
            {/* Kick/mute menu only available to the host, only against
                non-host participants. The host can't kick or mute themselves
                — the Rust commands also reject those cases server-side. */}
            {localIsHost && !p.is_host && (
              <button
                onClick={() =>
                  setOpenMenuFor(openMenuFor === p.id ? null : p.id)
                }
                title={t("participant_moderate_title")}
                aria-label={t("participant_moderate_aria", {
                  name: p.display_name,
                })}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  color: "inherit",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <MoreHorizontal size={12} />
              </button>
            )}
            {showMenu && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  right: 0,
                  zIndex: 10,
                  background: "var(--chat-input-bg)",
                  border: "1px solid var(--divider)",
                  borderRadius: 4,
                  display: "flex",
                  flexDirection: "column",
                  marginTop: 4,
                  minWidth: 140,
                }}
              >
                <button
                  style={moderationItemStyle}
                  onClick={async () => {
                    setOpenMenuFor(null);
                    try {
                      await muteParticipant(sessionId, p.id, !p.muted);
                    } catch (e) {
                      console.error("muteParticipant failed:", e);
                    }
                  }}
                >
                  <MicOff size={12} />
                  {p.muted ? t("participant_unmute") : t("participant_mute")}
                </button>
                <button
                  style={moderationItemStyle}
                  onClick={async () => {
                    setOpenMenuFor(null);
                    try {
                      await kickParticipant(sessionId, p.id);
                    } catch (e) {
                      console.error("kickParticipant failed:", e);
                    }
                  }}
                >
                  <UserMinus size={12} />
                  {t("participant_kick")}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const moderationItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: "transparent",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  color: "inherit",
  fontSize: 12,
};
