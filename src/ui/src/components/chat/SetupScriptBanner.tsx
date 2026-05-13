import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronRight, Loader2, Wrench } from "lucide-react";
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
 * `CliInvocationBanner` for the `claude` invocation.
 *
 * - **running** — a spinner + elapsed seconds while the script executes (a
 *   `bun install` can take 10-20s; the chip is the reassurance it's working).
 * - **completed** — collapsed by default; click to expand the full output.
 * - **failed / timed out** — danger treatment, expanded by default so it isn't
 *   missed.
 *
 * When the run produced no output there's nothing to expand, so the chip
 * renders without a toggle.
 */
export function SetupScriptBanner({ outcome, messageId }: Props) {
  const { t } = useTranslation("chat");

  const isRunning = outcome.status === "running";
  const isFailure = outcome.status === "failed" || outcome.status === "timed-out";
  const hasOutput = outcome.output.trim().length > 0;
  const storageKey = `claudette.setupScriptBanner.expanded:${messageId}`;
  const bodyId = `${storageKey}-body`;

  const elapsedSeconds = useElapsedSeconds(isRunning);

  const [expanded, setExpanded] = useState<boolean>(() =>
    readExpanded(storageKey, isFailure),
  );

  // `useState`'s lazy initializer only runs on first mount. The parent keys
  // each banner by `msg.id`, so `messageId` is effectively stable — but mirror
  // `CliInvocationBanner`'s resync so a remount with a different message (or a
  // status flip, e.g. running → failed) re-derives the default rather than
  // sticking to the old value.
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

  const statusLabel = isRunning
    ? t("setup_script_status_running")
    : outcome.status === "failed"
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

  const Icon = isRunning ? Loader2 : isFailure ? AlertTriangle : Wrench;
  const iconClass = isRunning
    ? `${styles.statusIcon} ${styles.spinner}`
    : styles.statusIcon;
  // `hasOutput` is always false while running (no output yet), so the running
  // chip naturally takes the static-header / no-toggle / no-copy path.
  const canExpand = hasOutput;

  return (
    <div
      className={`${styles.banner} ${expanded ? styles.expanded : ""} ${isRunning ? styles.running : ""} ${isFailure ? styles.failed : ""}`}
      data-testid="setup-script-banner"
      data-status={outcome.status}
    >
      {/* Same non-interactive-container-with-sibling-buttons shape as
          CliInvocationBanner — nesting the copy button inside the toggle
          would be invalid HTML and break keyboard/screen-reader behavior. */}
      <div className={styles.header}>
        {canExpand ? (
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
            <Icon size={13} className={iconClass} aria-hidden />
            <span className={styles.summary}>{summary}</span>
          </button>
        ) : (
          <div className={styles.staticHeader}>
            <Icon size={13} className={iconClass} aria-hidden />
            <span className={styles.summary}>{summary}</span>
            {isRunning && elapsedSeconds > 0 && (
              <span className={styles.elapsed}>· {elapsedSeconds}s</span>
            )}
          </div>
        )}
        {canExpand && (
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

      {canExpand && expanded && (
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

/** Whole seconds since the banner started showing the `running` state. We can
 *  only date it from when the placeholder message mounted (the run started a
 *  beat earlier), which is close enough for a reassurance counter. Resets and
 *  stops once `active` goes false. */
function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setSeconds(0);
      return;
    }
    startRef.current = Date.now();
    setSeconds(0);
    const id = window.setInterval(() => {
      if (startRef.current != null) {
        setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return seconds;
}
