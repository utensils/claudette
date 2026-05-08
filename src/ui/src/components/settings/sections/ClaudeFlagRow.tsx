import { useTranslation } from "react-i18next";
import type { ClaudeFlagDef } from "../../../services/claudeFlags";
import {
  type FlagRowVariant,
  flagInputKind,
  rowVariantIsEditable,
} from "./claudeFlagRowLogic";
import styles from "../Settings.module.css";

export interface ClaudeFlagRowProps {
  def: ClaudeFlagDef;
  variant: FlagRowVariant;
  enabled: boolean;
  value: string;
  /// Inherited rows display this badge when a repo override of the same name
  /// is shadowing the global entry rendered here.
  isOverridden?: boolean;
  /// Editable variants only.
  onToggleEnabled?: (next: boolean) => void;
  onValueChange?: (next: string) => void;
  /// Editable variants — remove the row's persisted state entirely.
  /// At global scope this disables the flag; at repo scope it clears the
  /// repo override and falls back to the inherited global.
  onClear?: () => void;
  /// `browse` and (un-shadowed) `inherited` variants — promote the flag
  /// into a configured / repo-override entry.
  onPromote?: () => void;
  /// Label for the promote button; the parent picks the wording because it
  /// depends on scope ("Add" vs "Override").
  promoteLabel?: string;
}

export function ClaudeFlagRow(props: ClaudeFlagRowProps) {
  const {
    def,
    variant,
    enabled,
    value,
    isOverridden = false,
    onToggleEnabled,
    onValueChange,
    onClear,
    onPromote,
    promoteLabel,
  } = props;
  const { t } = useTranslation("settings");
  const editable = rowVariantIsEditable(variant);
  const inputKind = flagInputKind(def);

  return (
    <div className={styles.flagRow} data-variant={variant}>
      <input
        type="checkbox"
        className={styles.flagCheckbox}
        checked={enabled}
        disabled={!editable}
        onChange={(e) => onToggleEnabled?.(e.target.checked)}
        aria-label={def.name}
      />

      <div className={styles.flagNameCell}>
        <span className={styles.flagName} title={def.name}>
          {def.name}
        </span>
        {def.short && <span className={styles.flagShort}>{def.short}</span>}
        {def.is_dangerous && (
          <span
            className={styles.flagDangerBadge}
            title={t("claude_flags_danger_warning")}
          >
            {t("claude_flags_danger_badge")}
          </span>
        )}
        {variant === "inherited" && isOverridden && (
          <span className={styles.flagOverriddenBadge}>
            {t("claude_flags_overridden_badge")}
          </span>
        )}
      </div>

      {def.description ? (
        <span className={styles.flagDescription} title={def.description}>
          {def.description}
        </span>
      ) : (
        <span className={styles.flagDescription} />
      )}

      <div className={styles.flagValueCell}>
        {inputKind === "text" && editable && (
          <input
            type="text"
            className={styles.flagInput}
            value={value}
            placeholder={def.value_placeholder ?? ""}
            onChange={(e) => onValueChange?.(e.target.value)}
            aria-label={`${def.name} value`}
          />
        )}
        {inputKind === "select" && editable && def.enum_choices && (
          <select
            className={styles.flagInput}
            value={value}
            onChange={(e) => onValueChange?.(e.target.value)}
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
        {!editable && inputKind !== "none" && value && (
          <span
            className={styles.flagValueReadonly}
            title={value}
            aria-label={`${def.name} value`}
          >
            {value}
          </span>
        )}
      </div>

      <div className={styles.flagActionCell}>
        {editable && onClear && (
          <button
            type="button"
            className={styles.flagIconBtn}
            onClick={onClear}
            aria-label={t("claude_flags_clear")}
            title={t("claude_flags_clear")}
          >
            ×
          </button>
        )}
        {!editable && onPromote && !isOverridden && (
          <button
            type="button"
            className={styles.flagPromoteBtn}
            onClick={onPromote}
          >
            {promoteLabel ?? t("claude_flags_add")}
          </button>
        )}
      </div>
    </div>
  );
}
