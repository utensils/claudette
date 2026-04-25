import { CircleCheck, CircleDashed, CircleQuestionMark, CircleAlert, LoaderCircle } from "lucide-react";

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
  switch (status.kind) {
    case "running":
      return (
        <LoaderCircle
          size={size}
          style={{ color: "var(--accent-primary)", animation: "spin 1s linear infinite" }}
        />
      );
    case "ask":
      return (
        <CircleQuestionMark
          size={size}
          style={{ color: "var(--badge-ask)" }}
        />
      );
    case "plan":
      return (
        <CircleAlert size={size} style={{ color: "var(--badge-plan)" }} />
      );
    case "unread":
      return (
        <CircleCheck size={size} style={{ color: "var(--badge-done)" }} />
      );
    case "idle":
      return <CircleDashed size={size} style={{ color: "var(--text-dim)" }} />;
  }
}
