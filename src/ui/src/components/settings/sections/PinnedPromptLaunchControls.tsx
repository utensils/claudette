import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useModelRegistry } from "../../chat/useModelRegistry";
import { findModelInRegistry, type Model } from "../../chat/modelRegistry";
import styles from "./PinnedPromptsManager.module.css";

/** The launch slice of a pinned prompt as the editor holds it. */
export interface PinnedPromptLaunchDraft {
  new_session: boolean;
  model: string | null;
  model_provider: string | null;
}

export const EMPTY_LAUNCH_DRAFT: PinnedPromptLaunchDraft = {
  new_session: false,
  model: null,
  model_provider: null,
};

/** Sentinel `<select>` value for "don't change the session's model". */
const INHERIT = "__inherit__";

/**
 * Encode a registry entry as a stable `<select>` option value.
 *
 * `providerQualifiedId` (`<backend>/<model>`) already exists for every
 * backend-injected entry precisely because model ids collide across
 * backends; curated Claude Code entries have no provider and use their bare
 * id. Reusing that field keeps this in lockstep with the chat model picker
 * and with `findModelInRegistry`'s lookup order.
 */
function optionValue(model: Model): string {
  return model.providerQualifiedId ?? model.id;
}

/** Inverse of `optionValue`. Unknown values fall back to "inherit". */
function decodeOptionValue(
  registry: readonly Model[],
  value: string,
): Pick<PinnedPromptLaunchDraft, "model" | "model_provider"> {
  if (value === INHERIT) return { model: null, model_provider: null };
  const entry = registry.find((m) => optionValue(m) === value);
  if (!entry) return { model: null, model_provider: null };
  return { model: entry.id, model_provider: entry.providerId ?? "anthropic" };
}

/**
 * The `<select>` value representing a stored model that the live registry
 * no longer exposes — the backend was disabled, or the model dropped out of
 * a provider manifest.
 *
 * We keep it selectable (rather than snapping the control back to
 * "inherit") so an unrelated edit to the pin doesn't silently discard the
 * user's model choice, and so re-enabling the backend restores it intact.
 */
function staleOptionValue(
  value: PinnedPromptLaunchDraft,
  selected: Model | undefined,
): string | null {
  if (!value.model || selected) return null;
  return value.model_provider
    ? `${value.model_provider}/${value.model}`
    : value.model;
}

/** Groups in registry order, so the picker reads like the chat one. */
function groupModels(registry: readonly Model[]): [string, Model[]][] {
  const groups = new Map<string, Model[]>();
  for (const model of registry) {
    const bucket = groups.get(model.group);
    if (bucket) bucket.push(model);
    else groups.set(model.group, [model]);
  }
  return [...groups.entries()];
}

interface Props {
  disabled?: boolean;
  value: PinnedPromptLaunchDraft;
  onChange: (next: PinnedPromptLaunchDraft) => void;
}

/**
 * "Advanced" launch options on a pinned prompt: open a new tab, and/or run
 * on a specific model.
 *
 * The two are deliberately independent. Selecting a model without "new tab"
 * switches the active session's model before the prompt runs — the same
 * thing the `/model` slash command does, including its context-preserving
 * behaviour on same-harness swaps.
 */
export function PinnedPromptLaunchControls({ disabled, value, onChange }: Props) {
  const { t } = useTranslation("settings");
  const registry = useModelRegistry();
  const checkboxId = useId();
  const selectId = useId();

  const grouped = useMemo(() => groupModels(registry), [registry]);

  const selected = useMemo(
    () =>
      value.model
        ? findModelInRegistry(
            registry,
            value.model,
            value.model_provider ?? "anthropic",
          )
        : undefined,
    [registry, value.model, value.model_provider],
  );

  const staleValue = staleOptionValue(value, selected);

  return (
    <div className={styles.overridesGroup}>
      <div className={styles.overridesLabel}>
        {t("pinned_prompts_launch_label")}
      </div>

      <div className={styles.overrideRow}>
        <label className={styles.autoSendLabel} htmlFor={checkboxId}>
          <input
            id={checkboxId}
            type="checkbox"
            checked={value.new_session}
            onChange={(e) =>
              onChange({ ...value, new_session: e.target.checked })
            }
            disabled={disabled}
          />
          {t("pinned_prompts_new_session")}
        </label>
      </div>
      <div className={styles.launchHint}>
        {t("pinned_prompts_new_session_hint")}
      </div>

      <div className={styles.overrideRow}>
        <label className={styles.overrideName} htmlFor={selectId}>
          {t("pinned_prompts_launch_model")}
        </label>
        <select
          id={selectId}
          className={styles.launchSelect}
          value={staleValue ?? (selected ? optionValue(selected) : INHERIT)}
          onChange={(e) => onChange({ ...value, ...decodeOptionValue(registry, e.target.value) })}
          disabled={disabled}
        >
          <option value={INHERIT}>
            {t("pinned_prompts_launch_model_inherit")}
          </option>
          {staleValue && (
            <option value={staleValue}>
              {t("pinned_prompts_launch_model_unavailable", {
                model: value.model,
              })}
            </option>
          )}
          {grouped.map(([group, models]) => (
            <optgroup key={group} label={group}>
              {models.map((model) => (
                <option key={optionValue(model)} value={optionValue(model)}>
                  {model.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {staleValue && (
        <div className={styles.launchWarning} role="status">
          {t("pinned_prompts_launch_model_unavailable_hint")}
        </div>
      )}
    </div>
  );
}
