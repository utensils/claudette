import { useEffect, useState } from "react";
import { BadgeCheck, BadgeInfo, BadgeQuestionMark, CircleDashed } from "lucide-react";
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from "../../utils/spinnerFrames";

export type SessionStatusKind =
  | { kind: "running" }
  | { kind: "ask" }
  | { kind: "plan" }
  | { kind: "unread" }
  | { kind: "idle" };

interface Props {
  status: SessionStatusKind;
  size?: number;
}

export function SessionStatusIcon({ status, size = 14 }: Props) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (status.kind !== "running") return;
    const id = window.setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => window.clearInterval(id);
  }, [status.kind]);

  switch (status.kind) {
    case "running":
      return (
        <span
          style={{
            fontFamily: "monospace",
            fontSize: size,
            color: "var(--accent-primary)",
            display: "inline-block",
            lineHeight: 1,
          }}
        >
          {SPINNER_FRAMES[frame]}
        </span>
      );
    case "ask":
      return (
        <BadgeQuestionMark
          size={size}
          style={{ color: "var(--accent-primary)" }}
        />
      );
    case "plan":
      return (
        <BadgeInfo size={size} style={{ color: "var(--accent-warning)" }} />
      );
    case "unread":
      return (
        <BadgeCheck size={size} style={{ color: "var(--accent-success)" }} />
      );
    case "idle":
      return <CircleDashed size={size} style={{ color: "var(--text-dim)" }} />;
  }
}
