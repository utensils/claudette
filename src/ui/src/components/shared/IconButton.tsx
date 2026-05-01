import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./IconButton.module.css";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The icon element. */
  children: ReactNode;
  /** Tooltip + aria-label. Required so every icon-only button is reachable. */
  tooltip: string;
}

export function IconButton({
  children,
  tooltip,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`${styles.button} ${className ?? ""}`}
      title={tooltip}
      aria-label={tooltip}
    >
      {children}
    </button>
  );
}
