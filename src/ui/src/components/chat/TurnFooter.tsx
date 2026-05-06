import React from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Split } from "lucide-react";
import { CopyButton } from "../shared/CopyButton";
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
      <CopyButton
        key="copy"
        variant="bare"
        className={styles.turnFooterButton}
        source={assistantText}
        tooltip={{ copy: t("copy_output"), copied: t("copy_output_done") }}
        ariaLabel={t("copy_agent_output_aria")}
        stopPropagation
      />,
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
