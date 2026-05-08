import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Terminal } from "lucide-react";
import { CopyButton } from "../shared/CopyButton";
import {
  parseInvocation,
  shouldShowBanner,
  summarizeInvocation,
} from "./cliInvocationBannerLogic";
import styles from "./CliInvocationBanner.module.css";

interface Props {
  /** The redacted shell-quoted invocation persisted on the chat session. */
  invocation: string | null;
  /**
   * Stable identifier for this banner instance. Used to scope expand/collapse
   * state to a single chat session — switching tabs should not bleed the
   * previous tab's expanded state across.
   */
  sessionId?: string;
}

/**
 * The literal `claude` invocation that started this session, redacted of
 * sensitive flag values and with the prompt positional replaced by
 * `<prompt>`. Pinned above the message list as the first block in the tab.
 *
 * Renders as a compact chip by default that expands on click into a
 * structured per-flag list. Per-session state lives in `sessionStorage` so
 * the user's last expand choice survives a refresh but doesn't bleed across
 * unrelated chat tabs.
 */
export function CliInvocationBanner({ invocation, sessionId }: Props) {
  const { t } = useTranslation("chat");
  const storageKey = sessionId
    ? `claudette.cliInvocationBanner.expanded:${sessionId}`
    : null;

  const [expanded, setExpanded] = useState<boolean>(() => {
    if (!storageKey) return false;
    try {
      return sessionStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  // `useState`'s lazy initializer only runs on first mount. When the user
  // switches chat tabs, ChatPanel keeps the banner mounted and just hands
  // it a new `sessionId` — without this resync the previous tab's expand
  // state would bleed over until the user toggled. Per-session state must
  // really be per-session.
  useEffect(() => {
    if (!storageKey) {
      setExpanded(false);
      return;
    }
    try {
      setExpanded(sessionStorage.getItem(storageKey) === "1");
    } catch {
      setExpanded(false);
    }
  }, [storageKey]);

  const parsed = useMemo(
    () => (invocation ? parseInvocation(invocation) : null),
    [invocation],
  );

  const summary = useMemo(
    () => (parsed ? summarizeInvocation(parsed) : ""),
    [parsed],
  );

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (storageKey) {
        try {
          sessionStorage.setItem(storageKey, next ? "1" : "0");
        } catch {
          /* ignore quota / privacy errors */
        }
      }
      return next;
    });
  }, [storageKey]);

  const copySource = useCallback(() => parsed?.raw ?? null, [parsed]);

  if (!shouldShowBanner(invocation) || !parsed) return null;

  return (
    <div
      className={`${styles.banner} ${expanded ? styles.expanded : ""}`}
      data-testid="cli-invocation-banner"
    >
      {/* Header is a non-interactive container with two sibling buttons.
          Nesting <button>s (toggle around CopyButton) is invalid HTML and
          breaks keyboard / screen-reader behavior — see the discussion in
          the PR review. The toggle button takes the wide left region; the
          copy button is its own click target on the right. */}
      <div className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          onClick={handleToggle}
          aria-expanded={expanded}
          aria-controls={
            storageKey ? `${storageKey}-body` : "cli-invocation-banner-body"
          }
          title={
            expanded
              ? t("cli_invocation_collapse")
              : t("cli_invocation_expand")
          }
        >
          <ChevronRight
            size={14}
            className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
            aria-hidden
          />
          <Terminal size={13} className={styles.binaryIcon} aria-hidden />
          <span className={styles.summary}>{summary}</span>
        </button>
        <CopyButton
          variant="bare"
          className={styles.copyButton}
          source={copySource}
          tooltip={{
            copy: t("cli_invocation_copy"),
            copied: t("cli_invocation_copied"),
          }}
          ariaLabel={t("cli_invocation_copy")}
          stopPropagation
        />
      </div>

      {expanded && (
        <div
          id={
            storageKey ? `${storageKey}-body` : "cli-invocation-banner-body"
          }
          className={styles.body}
        >
          <div className={styles.binaryRow}>
            <span className={styles.binaryName}>{parsed.binary}</span>
            {parsed.binaryFullPath !== parsed.binary && (
              <span
                className={styles.binaryPath}
                title={parsed.binaryFullPath}
              >
                {parsed.binaryFullPath}
              </span>
            )}
          </div>
          <ul className={styles.flagList}>
            {parsed.flags.map((flag, i) => (
              <li key={`${flag.name}-${i}`} className={styles.flagRow}>
                <span className={styles.flagName}>{flag.name}</span>
                {/* Always emit the value cell, even when null. With
                    `display: contents` rows, a missing cell would let the
                    next flag's name slide into this row's value column —
                    breaking column alignment for every following row. */}
                <span
                  className={`${styles.flagValue} ${flag.value === "<redacted>" ? styles.flagValueRedacted : ""} ${flag.value === null ? styles.flagValueEmpty : ""}`}
                  aria-hidden={flag.value === null}
                >
                  {flag.value ?? ""}
                </span>
              </li>
            ))}
            {parsed.prompt && (
              <li
                className={`${styles.flagRow} ${styles.flagRowPositional}`}
              >
                <span className={styles.positionalLabel}>
                  {t("cli_invocation_prompt_label")}
                </span>
                <span className={styles.flagValue}>{parsed.prompt}</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
