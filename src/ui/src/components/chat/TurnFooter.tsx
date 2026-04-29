import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Split } from "lucide-react";
import styles from "./ChatPanel.module.css";
import { formatTokens } from "./formatTokens";
import { formatDurationMs } from "./chatHelpers";

/** Bottom-of-turn action row: elapsed time, copy output, fork, rollback.
 *  Rendered below the turn summary for every completed turn. */
export function TurnFooter({
  durationMs,
  inputTokens,
  outputTokens,
  assistantText,
  onFork,
  onRollback,
  className,
}: {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  assistantText?: string;
  onFork?: () => void;
  onRollback?: () => void;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!assistantText) return;
    navigator.clipboard
      .writeText(assistantText)
      .then(() => {
        setCopied(true);
        if (copyTimeoutRef.current !== null) {
          window.clearTimeout(copyTimeoutRef.current);
        }
        copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch((err) => {
        console.error("Copy to clipboard failed:", err);
      });
  };

  const handleFork = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFork?.();
  };

  const handleRollback = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRollback?.();
  };

  const tokensNode =
    typeof inputTokens === "number" && typeof outputTokens === "number" ? (
      <span key="tokens" className={styles.turnFooterTokens}>
        {formatTokens(inputTokens)} in · {formatTokens(outputTokens)} out
      </span>
    ) : null;

  const elapsedNode =
    typeof durationMs === "number" && durationMs > 0 ? (
      <span key="elapsed" className={styles.turnFooterElapsed}>
        {formatDurationMs(durationMs)}
      </span>
    ) : null;

  const actionButtons: React.ReactNode[] = [];
  if (assistantText) {
    actionButtons.push(
      <button
        key="copy"
        type="button"
        className={styles.turnFooterButton}
        onClick={handleCopy}
        title={copied ? t("copy_output_done") : t("copy_output")}
        aria-label={t("copy_agent_output_aria")}
      >
        {copied ? (
          // Checkmark feedback for ~1.2s after successful copy.
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        )}
      </button>,
    );
  }
  if (onFork) {
    actionButtons.push(
      <button
        key="fork"
        type="button"
        className={styles.turnFooterButton}
        onClick={handleFork}
        title={t("fork_workspace")}
        aria-label={t("fork_workspace")}
      >
        <Split size={14} />
      </button>,
    );
  }
  if (onRollback) {
    actionButtons.push(
      <button
        key="rollback"
        type="button"
        className={styles.turnFooterButton}
        onClick={handleRollback}
        title={t("rollback_turn")}
        aria-label={t("rollback_turn")}
      >
        <RotateCcw size={14} />
      </button>,
    );
  }

  if (!tokensNode && !elapsedNode && actionButtons.length === 0) return null;

  const hasMetadata = !!(tokensNode || elapsedNode);

  return (
    <div
      className={`${styles.turnFooter}${className ? ` ${className}` : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      {tokensNode}
      {tokensNode && elapsedNode && (
        <span className={styles.turnFooterDot} aria-hidden="true">·</span>
      )}
      {elapsedNode}
      {hasMetadata && actionButtons.length > 0 && (
        <span className={styles.turnFooterDot} aria-hidden="true">·</span>
      )}
      {actionButtons}
    </div>
  );
}
