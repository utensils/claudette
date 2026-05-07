import { useTranslation } from "react-i18next";
import type { ClaudeFlagDef } from "../../../services/claudeFlags";
import {
  type FlagRowScope,
  flagInputKind,
  rowIsReadOnly,
} from "./claudeFlagRowLogic";
import styles from "../Settings.module.css";

export interface ClaudeFlagRowProps {
  def: ClaudeFlagDef;
  enabled: boolean;
  value: string;
  scope: FlagRowScope;
  /// Repo scope only: is the row currently overriding global? When false in
  /// repo scope, inputs render disabled showing the inherited values.
  isOverride?: boolean;
  onToggleEnabled: (next: boolean) => void;
  onValueChange: (next: string) => void;
  /// Repo scope only.
  onToggleOverride?: (next: boolean) => void;
}

export function ClaudeFlagRow(props: ClaudeFlagRowProps) {
  const {
    def,
    enabled,
    value,
    scope,
    isOverride = false,
    onToggleEnabled,
    onValueChange,
    onToggleOverride,
  } = props;
  const { t } = useTranslation("settings");
  const readOnly = rowIsReadOnly(scope, isOverride);
  const inputKind = flagInputKind(def);

  return (
    <div className={styles.flagRow}>
      <input
        type="checkbox"
        checked={enabled}
        disabled={readOnly}
        onChange={(e) => onToggleEnabled(e.target.checked)}
        aria-label={def.name}
      />
      <div className={styles.flagInfo}>
        <div>
          <span className={styles.flagName}>{def.name}</span>
          {def.short && <span className={styles.flagShort}>{def.short}</span>}
          {def.is_dangerous && (
            <span
              className={styles.flagDangerBadge}
              title={t("claude_flags_danger_warning")}
            >
              {t("claude_flags_danger_badge")}
            </span>
          )}
        </div>
        {def.description && (
          <div className={styles.flagDescription}>{def.description}</div>
        )}
      </div>
      <div className={styles.flagControls}>
        {scope === "repo" && !isOverride && (
          <span className={styles.flagInheritedHint}>
            {t("claude_flags_inheriting_global")}
          </span>
        )}
        {inputKind === "text" && (
          <input
            type="text"
            className={styles.flagInput}
            value={value}
            disabled={readOnly}
            placeholder={def.value_placeholder ?? ""}
            onChange={(e) => onValueChange(e.target.value)}
            aria-label={`${def.name} value`}
          />
        )}
        {inputKind === "select" && def.enum_choices && (
          <select
            className={styles.flagInput}
            value={value}
            disabled={readOnly}
            onChange={(e) => onValueChange(e.target.value)}
            aria-label={`${def.name} value`}
          >
            <option value="">--</option>
            {def.enum_choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        )}
        {scope === "repo" && onToggleOverride && (
          <label className={styles.flagOverrideRow}>
            <input
              type="checkbox"
              checked={isOverride}
              onChange={(e) => onToggleOverride(e.target.checked)}
            />
            {t("claude_flags_override_label")}
          </label>
        )}
      </div>
    </div>
  );
}
