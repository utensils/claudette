import type { CSSProperties, ReactNode } from "react";
import styles from "./Spinner.module.css";

const SPINNER_DURATIONS = {
  default: "0.4s",
  medium: "0.45s",
  relaxed: "0.5s",
  slow: "1s",
} as const;

type SpinnerDuration = keyof typeof SPINNER_DURATIONS;

interface SpinnerProps {
  size?: number;
  duration?: SpinnerDuration;
  className?: string;
  label?: string;
  title?: string;
  children?: ReactNode;
}

export function Spinner({
  size = 14,
  duration = "default",
  className,
  label,
  title,
  children,
}: SpinnerProps) {
  const style = {
    width: size,
    height: size,
    "--spinner-duration": SPINNER_DURATIONS[duration],
  } as CSSProperties;
  const accessibilityProps = label
    ? { role: "status", "aria-label": label }
    : { "aria-hidden": true };

  return (
    <span
      className={`${styles.spinner}${className ? ` ${className}` : ""}`}
      style={style}
      title={title ?? label}
      {...accessibilityProps}
    >
      <span className={`${styles.content}${children ? "" : ` ${styles.ring}`}`}>
        {children}
      </span>
    </span>
  );
}
