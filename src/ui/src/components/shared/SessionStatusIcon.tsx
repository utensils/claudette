import { CircleCheck, CircleDashed, CircleQuestionMark, CircleAlert, CircleStop, LoaderCircle } from "lucide-react";
import styles from "./SessionStatusIcon.module.css";

export type SessionStatusKind =
  | { kind: "running" }
  | { kind: "ask" }
  | { kind: "plan" }
  | { kind: "unread" }
  | { kind: "stopped" }
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
          className={styles.spinner}
          style={{ color: "var(--accent-primary)" }}
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
    case "stopped":
      return (
        <CircleStop size={size} style={{ color: "var(--status-stopped)" }} />
      );
    case "idle":
      return <CircleDashed size={size} style={{ color: "var(--text-dim)" }} />;
  }
}
