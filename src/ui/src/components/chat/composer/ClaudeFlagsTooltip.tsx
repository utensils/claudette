// Shows what flags the next turn will use, not historical argv.
import { useId } from "react";
import { Flag } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ResolvedFlag } from "../../../stores/slices/workspaceClaudeFlagsSlice";
import styles from "./ClaudeFlagsTooltip.module.css";

const MAX_DISPLAYED = 10;

interface ClaudeFlagsTooltipProps {
  resolved: ResolvedFlag[];
}

export function ClaudeFlagsTooltip({ resolved }: ClaudeFlagsTooltipProps) {
  const { t } = useTranslation("settings");
  const tooltipId = useId();
  const visible = resolved.slice(0, MAX_DISPLAYED);
  const hidden = Math.max(0, resolved.length - MAX_DISPLAYED);
  const hasDangerous = resolved.some((f) => f.isDangerous);
  const hasAny = resolved.length > 0;

  const triggerClass = hasDangerous
    ? `${styles.trigger} ${styles.triggerDanger}`
    : hasAny
      ? `${styles.trigger} ${styles.triggerActive}`
      : styles.trigger;

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={triggerClass}
        aria-label={t("claude_flags_tooltip_aria_label")}
        aria-describedby={tooltipId}
      >
        <Flag size={14} aria-hidden />
      </button>
      <span id={tooltipId} className={styles.panel} role="tooltip">
        {resolved.length === 0 ? (
          <span className={styles.empty}>
            {t("claude_flags_footer_tooltip_empty")}
          </span>
        ) : (
          <>
            <ul className={styles.list}>
              {visible.map((flag) => (
                <li
                  key={flag.name}
                  className={`${styles.row} ${flag.isDangerous ? styles.danger : ""}`}
                >
                  <span>{flag.name}</span>
                  {flag.value !== undefined && flag.value !== "" && (
                    <span className={styles.value}>{flag.value}</span>
                  )}
                </li>
              ))}
            </ul>
            {hidden > 0 && (
              <div className={styles.more}>
                {t("claude_flags_tooltip_overflow", { count: hidden })}
              </div>
            )}
          </>
        )}
      </span>
    </span>
  );
}
