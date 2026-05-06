import type { MouseEvent, ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { IconButton } from "./IconButton";
import {
  type CopySource,
  useCopyToClipboard,
  type UseCopyToClipboardOptions,
} from "../../hooks/useCopyToClipboard";
import styles from "./CopyButton.module.css";

interface TooltipLabels {
  copy: string;
  copied: string;
  failed?: string;
}

interface CopyButtonProps extends UseCopyToClipboardOptions {
  source: CopySource;
  tooltip: TooltipLabels;
  className?: string;
  iconSize?: number;
  /** "icon-button" wraps `<IconButton>` (toolbar buttons in DiffViewer/
   *  FileViewer). "bare" renders a plain `<button>` so chat call sites
   *  keep their CSS-driven styling. */
  variant?: "icon-button" | "bare";
  disabled?: boolean;
  ariaLabel?: string;
  /** Optional render node for "extra" content next to the icon (e.g. a
   *  text label for compact toolbars that don't have room for both). */
  children?: ReactNode;
  stopPropagation?: boolean;
}

export function CopyButton({
  source,
  tooltip,
  className,
  iconSize = 14,
  variant = "icon-button",
  disabled,
  ariaLabel,
  resetMs,
  onError,
  children,
  stopPropagation,
}: CopyButtonProps) {
  const { state, copy } = useCopyToClipboard({ resetMs, onError });

  const tooltipText =
    state === "copied"
      ? tooltip.copied
      : state === "error"
        ? (tooltip.failed ?? tooltip.copy)
        : tooltip.copy;

  const handleClick = (e: MouseEvent) => {
    if (stopPropagation) e.stopPropagation();
    void copy(source);
  };

  const icon =
    state === "copied" ? (
      <Check size={iconSize} aria-hidden="true" />
    ) : (
      <Copy size={iconSize} aria-hidden="true" />
    );

  if (variant === "icon-button") {
    return (
      <IconButton
        onClick={handleClick}
        tooltip={tooltipText}
        aria-live="polite"
        disabled={disabled}
        className={`${styles.copyButton} ${className ?? ""}`}
        data-state={state}
      >
        {icon}
        {children}
      </IconButton>
    );
  }

  return (
    <button
      type="button"
      className={`${styles.copyButton} ${className ?? ""}`}
      onClick={handleClick}
      title={tooltipText}
      // Default to the state-aware tooltipText so screen readers announce
      // the same "Copied!" / "Copy failed" feedback the sighted user gets.
      // Callers that want a static label (e.g. "Copy message") can pass an
      // explicit `ariaLabel` to opt out.
      aria-label={ariaLabel ?? tooltipText}
      aria-live="polite"
      disabled={disabled}
      data-state={state}
    >
      {icon}
      {children}
    </button>
  );
}
