import { CircleCheck, CircleDashed, CircleQuestionMark, CircleAlert, CircleStop } from "lucide-react";
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
        <span
          className={styles.spinnerWrap}
          style={{ width: size, height: size }}
        >
          <span className={styles.spinner} />
        </span>
      );
    case "ask":
      return (
        <span className={styles.pulse}>
          <CircleQuestionMark size={size} style={{ color: "var(--badge-ask)" }} />
        </span>
      );
    case "plan":
      return (
        <span className={styles.pulse}>
          <CircleAlert size={size} style={{ color: "var(--badge-plan)" }} />
        </span>
      );
    case "unread":
      return (
        <span className={styles.pulse}>
          <CircleCheck size={size} style={{ color: "var(--badge-done)" }} />
        </span>
      );
    case "stopped":
      return (
        <CircleStop size={size} style={{ color: "var(--status-stopped)" }} />
      );
    case "idle":
      return <CircleDashed size={size} style={{ color: "var(--text-dim)" }} />;
  }
}
