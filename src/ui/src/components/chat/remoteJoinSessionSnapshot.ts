import type {
  Participant,
  ParticipantVote,
} from "../../stores/slices/collabSlice";
import { parseAskUserQuestion } from "../../hooks/parseAgentQuestion";

interface PendingVoteSnapshot {
  tool_use_id?: string;
  required_voters?: Participant[];
  votes?: Record<string, ParticipantVote>;
  input?: unknown;
  plan_file_path?: string | null;
}

interface PendingQuestionSnapshot {
  tool_use_id?: string;
  required_voters?: Participant[];
  votes?: Record<string, { answers: Record<string, string> }>;
  input?: unknown;
}

interface JoinSessionSnapshot {
  participants?: Participant[];
  turn_holder?: string | null;
  turn_started_at_ms?: number | null;
  turn_settings?: {
    model?: string | null;
    plan_mode?: boolean;
  } | null;
  pending_vote?: PendingVoteSnapshot | null;
  pending_question?: PendingQuestionSnapshot | null;
}

interface SnapshotActions {
  setParticipants: (sessionId: string, participants: Participant[]) => void;
  setTurnHolder: (
    sessionId: string,
    holder: { participant_id: string; display_name: string } | null,
  ) => void;
  setPromptStartTime?: (startedAtMs: number) => void;
  setSelectedModel?: (sessionId: string, model: string) => void;
  setPlanMode?: (sessionId: string, enabled: boolean) => void;
  openConsensusVote?: (
    sessionId: string,
    toolUseId: string,
    requiredVoters: Participant[],
  ) => void;
  recordConsensusVote?: (
    sessionId: string,
    toolUseId: string,
    participantId: string,
    vote: ParticipantVote,
  ) => void;
  setPlanApproval?: (approval: {
    sessionId: string;
    toolUseId: string;
    planFilePath: string | null;
    allowedPrompts: Array<{ tool: string; prompt: string }>;
  }) => void;
  setAgentQuestion?: (question: {
    sessionId: string;
    toolUseId: string;
    questions: ReturnType<typeof parseAskUserQuestion>;
    requiredVoters?: Participant[];
    votes?: Record<string, { answers: Record<string, string> }>;
  }) => void;
}

function asSnapshot(value: unknown): JoinSessionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  return value as JoinSessionSnapshot;
}

export function applyRemoteJoinSessionSnapshot(
  sessionId: string,
  value: unknown,
  actions: SnapshotActions,
): void {
  const snapshot = asSnapshot(value);
  if (!snapshot) return;

  const participants = Array.isArray(snapshot.participants)
    ? snapshot.participants
    : null;
  if (participants) {
    actions.setParticipants(sessionId, participants);
  }

  if (typeof snapshot.turn_holder === "string") {
    const holder = participants?.find((p) => p.id === snapshot.turn_holder);
    actions.setTurnHolder(sessionId, {
      participant_id: snapshot.turn_holder,
      display_name: holder?.display_name ?? snapshot.turn_holder,
    });
  } else if (snapshot.turn_holder === null) {
    actions.setTurnHolder(sessionId, null);
  }

  if (
    typeof snapshot.turn_started_at_ms === "number" &&
    snapshot.turn_started_at_ms > 0
  ) {
    actions.setPromptStartTime?.(snapshot.turn_started_at_ms);
  }

  const turnSettings = snapshot.turn_settings;
  if (turnSettings && typeof turnSettings === "object") {
    if (typeof turnSettings.model === "string" && turnSettings.model) {
      actions.setSelectedModel?.(sessionId, turnSettings.model);
    }
    if (typeof turnSettings.plan_mode === "boolean") {
      actions.setPlanMode?.(sessionId, turnSettings.plan_mode);
    }
  }

  const pendingVote = snapshot.pending_vote;
  if (
    pendingVote &&
    typeof pendingVote.tool_use_id === "string" &&
    Array.isArray(pendingVote.required_voters)
  ) {
    actions.openConsensusVote?.(
      sessionId,
      pendingVote.tool_use_id,
      pendingVote.required_voters,
    );
    for (const [participantId, vote] of Object.entries(pendingVote.votes ?? {})) {
      actions.recordConsensusVote?.(
        sessionId,
        pendingVote.tool_use_id,
        participantId,
        vote,
      );
    }
    actions.setPlanApproval?.({
      sessionId,
      toolUseId: pendingVote.tool_use_id,
      planFilePath:
        typeof pendingVote.plan_file_path === "string"
          ? pendingVote.plan_file_path
          : null,
      allowedPrompts: parseAllowedPrompts(pendingVote.input),
    });
    actions.setPlanMode?.(sessionId, false);
  }

  const pendingQuestion = snapshot.pending_question;
  if (
    pendingQuestion &&
    typeof pendingQuestion.tool_use_id === "string" &&
    pendingQuestion.input &&
    typeof pendingQuestion.input === "object"
  ) {
    const questions = parseAskUserQuestion(
      pendingQuestion.input as Record<string, unknown>,
    );
    if (questions.length > 0) {
      actions.setAgentQuestion?.({
        sessionId,
        toolUseId: pendingQuestion.tool_use_id,
        questions,
        requiredVoters: Array.isArray(pendingQuestion.required_voters)
          ? pendingQuestion.required_voters
          : undefined,
        votes: pendingQuestion.votes,
      });
    }
  }
}

function parseAllowedPrompts(
  input: unknown,
): Array<{ tool: string; prompt: string }> {
  if (!input || typeof input !== "object" || !("allowedPrompts" in input)) {
    return [];
  }
  const allowedPrompts = (input as { allowedPrompts?: unknown }).allowedPrompts;
  if (!Array.isArray(allowedPrompts)) return [];
  return allowedPrompts.filter(
    (item): item is { tool: string; prompt: string } =>
      !!item &&
      typeof item === "object" &&
      typeof (item as { tool?: unknown }).tool === "string" &&
      typeof (item as { prompt?: unknown }).prompt === "string",
  );
}
