import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";

/** One connected user in a collaborative session. Mirrors the Rust
 *  `claudette::room::ParticipantInfo`. The id is opaque (sha-256 of the
 *  session token); display name comes from the share's pairing. */
export interface Participant {
  id: string;
  display_name: string;
  is_host: boolean;
  joined_at: number;
  muted: boolean;
}

/** Snake-cased to match the Rust `Vote` enum's serde representation. */
export type ParticipantVote =
  | { kind: "approve" }
  | { kind: "deny"; reason: string };

/** Live state of an open ExitPlanMode consensus vote. Populated when the
 *  server emits `plan-vote-opened` and updated by `plan-vote-cast` events
 *  as participants vote. Cleared on `plan-vote-resolved`. */
export interface ConsensusVote {
  toolUseId: string;
  requiredVoters: Participant[];
  votes: Record<string, ParticipantVote>;
}

export interface CollabSlice {
  // -- Global preferences (loaded from app_settings on boot) --
  /** Persisted via `app_settings:collab:display_name`. Empty string means
   *  "fall back to OS hostname"; the Rust side resolves the fallback. */
  collabDisplayName: string;
  setCollabDisplayName: (name: string) => void;
  /** Persisted via `app_settings:collab:default_consensus_required`. */
  collabDefaultConsensusRequired: boolean;
  setCollabDefaultConsensusRequired: (v: boolean) => void;

  // -- Per-session live state --
  participants: Record<string, Participant[]>;
  setParticipants: (sessionId: string, participants: Participant[]) => void;
  clearParticipants: (sessionId: string) => void;
  currentTurnHolder: Record<
    string,
    { participant_id: string; display_name: string } | null
  >;
  setTurnHolder: (
    sessionId: string,
    holder: { participant_id: string; display_name: string } | null,
  ) => void;
  consensusVotes: Record<string, ConsensusVote>;
  openConsensusVote: (
    sessionId: string,
    toolUseId: string,
    requiredVoters: Participant[],
  ) => void;
  recordConsensusVote: (
    sessionId: string,
    toolUseId: string,
    participantId: string,
    vote: ParticipantVote,
  ) => void;
  clearConsensusVote: (sessionId: string) => void;
}

export const createCollabSlice: StateCreator<AppState, [], [], CollabSlice> = (
  set,
) => ({
  collabDisplayName: "",
  setCollabDisplayName: (name) => set({ collabDisplayName: name }),
  collabDefaultConsensusRequired: false,
  setCollabDefaultConsensusRequired: (v) =>
    set({ collabDefaultConsensusRequired: v }),

  participants: {},
  setParticipants: (sessionId, participants) =>
    set((s) => ({
      participants: { ...s.participants, [sessionId]: participants },
    })),
  clearParticipants: (sessionId) =>
    set((s) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [sessionId]: _removed, ...rest } = s.participants;
      return { participants: rest };
    }),

  currentTurnHolder: {},
  setTurnHolder: (sessionId, holder) =>
    set((s) => ({
      currentTurnHolder: { ...s.currentTurnHolder, [sessionId]: holder },
    })),

  consensusVotes: {},
  openConsensusVote: (sessionId, toolUseId, requiredVoters) =>
    set((s) => ({
      consensusVotes: {
        ...s.consensusVotes,
        [sessionId]: { toolUseId, requiredVoters, votes: {} },
      },
    })),
  recordConsensusVote: (sessionId, toolUseId, participantId, vote) =>
    set((s) => {
      const existing = s.consensusVotes[sessionId];
      // Ignore stale votes for a different round so a slow network can't
      // overwrite a freshly-opened consensus.
      if (!existing || existing.toolUseId !== toolUseId) {
        return s;
      }
      return {
        consensusVotes: {
          ...s.consensusVotes,
          [sessionId]: {
            ...existing,
            votes: { ...existing.votes, [participantId]: vote },
          },
        },
      };
    }),
  clearConsensusVote: (sessionId) =>
    set((s) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [sessionId]: _removed, ...rest } = s.consensusVotes;
      return { consensusVotes: rest };
    }),
});
