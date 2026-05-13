import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronRight, Wrench } from "lucide-react";
import { CopyButton } from "../shared/CopyButton";
import type { SetupScriptOutcome } from "../../utils/setupScriptMessage";
import styles from "./SetupScriptBanner.module.css";

interface Props {
  outcome: SetupScriptOutcome;
  /**
   * Id of the `System` message this banner renders in place of. Scopes the
   * expand/collapse memory so two setup runs in the same chat session keep
   * independent state, and so the choice survives a refresh.
   */
  messageId: string;
}

/**
 * A repo setup script's stdout/stderr, rendered as a compact one-line chip in
 * the transcript instead of a screenful of install logs — same affordance as
 * `CliInvocationBanner` for the `claude` invocation. Collapsed by default for
 * a successful run; a failed or timed-out run gets a danger treatment and
 * starts expanded so it isn't missed. Clicking the header toggles the full
 * output. When the run produced no output there's nothing to expand, so the
 * chip renders without a toggle.
 */
export function SetupScriptBanner({ outcome, messageId }: Props) {
  const { t } = useTranslation("chat");

  const isFailure = outcome.status !== "completed";
  const hasOutput = outcome.output.trim().length > 0;
  const storageKey = `claudette.setupScriptBanner.expanded:${messageId}`;
  const bodyId = `${storageKey}-body`;

  const [expanded, setExpanded] = useState<boolean>(() =>
    readExpanded(storageKey, isFailure),
  );

  // `useState`'s lazy initializer only runs on first mount. The parent keys
  // each banner by `msg.id`, so `messageId` is effectively stable — but mirror
  // `CliInvocationBanner`'s resync so a remount with a different message (or a
  // status flip) re-derives the default rather than sticking to the old value.
  useEffect(() => {
    setExpanded(readExpanded(storageKey, isFailure));
  }, [storageKey, isFailure]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        sessionStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore quota / privacy errors */
      }
      return next;
    });
  }, [storageKey]);

  const statusLabel =
    outcome.status === "failed"
      ? t("setup_script_status_failed")
      : outcome.status === "timed-out"
        ? t("setup_script_status_timed_out")
        : t("setup_script_status_completed");

  const summary = useMemo(() => {
    const src = outcome.source ? ` (${outcome.source})` : "";
    return `${t("setup_script_label")}${src} · ${statusLabel}`;
  }, [outcome.source, statusLabel, t]);

  const copySource = useCallback(
    () => (hasOutput ? outcome.output : null),
    [hasOutput, outcome.output],
  );

  const Icon = isFailure ? AlertTriangle : Wrench;

  return (
    <div
      className={`${styles.banner} ${expanded ? styles.expanded : ""} ${isFailure ? styles.failed : ""}`}
      data-testid="setup-script-banner"
      data-status={outcome.status}
    >
      {/* Same non-interactive-container-with-sibling-buttons shape as
          CliInvocationBanner — nesting the copy button inside the toggle
          would be invalid HTML and break keyboard/screen-reader behavior. */}
      <div className={styles.header}>
        {hasOutput ? (
          <button
            type="button"
            className={styles.toggle}
            onClick={handleToggle}
            aria-expanded={expanded}
            aria-controls={bodyId}
            title={expanded ? t("setup_script_collapse") : t("setup_script_expand")}
          >
            <ChevronRight
              size={14}
              className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
              aria-hidden
            />
            <Icon size={13} className={styles.statusIcon} aria-hidden />
            <span className={styles.summary}>{summary}</span>
          </button>
        ) : (
          <div className={styles.staticHeader}>
            <Icon size={13} className={styles.statusIcon} aria-hidden />
            <span className={styles.summary}>{summary}</span>
          </div>
        )}
        {hasOutput && (
          <CopyButton
            variant="bare"
            className={styles.copyButton}
            source={copySource}
            tooltip={{
              copy: t("setup_script_copy"),
              copied: t("setup_script_copied"),
            }}
            ariaLabel={t("setup_script_copy")}
            stopPropagation
          />
        )}
      </div>

      {hasOutput && expanded && (
        <div id={bodyId} className={styles.body}>
          <pre className={styles.output}>{outcome.output}</pre>
        </div>
      )}
    </div>
  );
}

/** Read the persisted expand choice, falling back to `defaultExpanded` (true
 *  for failed/timed-out runs) when nothing's been stored yet. */
function readExpanded(key: string, defaultExpanded: boolean): boolean {
  try {
    const stored = sessionStorage.getItem(key);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    /* ignore */
  }
  return defaultExpanded;
}
