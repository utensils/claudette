/**
 * Renders a single typed input for a plugin manifest setting.
 *
 * Used in two contexts that share the same wire-shape:
 *   - Plugins settings panel — global per-plugin overrides.
 *   - Repo settings → Environment subsection — per-repo overrides.
 *
 * Both pass `null` to `onChange` to clear the override and revert to
 * the next-lower precedence (manifest default for global; global
 * setting for per-repo). Lifting the component out of
 * `PluginsSettings.tsx` keeps the boolean/text/select/number rendering
 * in one place so the two surfaces never drift on input semantics.
 */
import type { PluginSettingField } from "../../types/claudettePlugins";
import styles from "./Settings.module.css";

export interface PluginSettingInputProps {
  field: PluginSettingField;
  value: unknown;
  onChange: (value: unknown) => void;
}

export function PluginSettingInput({
  field,
  value,
  onChange,
}: PluginSettingInputProps) {
  if (field.type === "boolean") {
    const checked = value === true;
    return (
      <label className={styles.pluginSettingRow}>
        <button
          type="button"
          className={`${styles.mcpToggle} ${checked ? styles.mcpToggleOn : ""}`}
          onClick={() => onChange(!checked)}
          role="switch"
          aria-checked={checked}
          aria-label={field.label}
        >
          <span className={styles.mcpToggleKnob} />
        </button>
        <div>
          <div className={styles.pluginSettingLabel}>{field.label}</div>
          {field.description && (
            <div className={styles.envErrorHint}>{field.description}</div>
          )}
        </div>
      </label>
    );
  }

  if (field.type === "text") {
    const stringValue = typeof value === "string" ? value : (field.default ?? "");
    return (
      <div className={styles.pluginSettingRow}>
        <div>
          <div className={styles.pluginSettingLabel}>{field.label}</div>
          {field.description && (
            <div className={styles.envErrorHint}>{field.description}</div>
          )}
          <input
            type="text"
            value={stringValue}
            placeholder={field.placeholder ?? ""}
            onChange={(e) => onChange(e.target.value || null)}
            className={styles.textInput}
          />
        </div>
      </div>
    );
  }

  if (field.type === "number") {
    // Coerce whatever the store handed us into a stringy display
    // value: numbers and numeric strings round-trip cleanly; anything
    // else falls back to "" so the input shows the placeholder rather
    // than silently rendering garbage.
    const numericValue =
      typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))
          ? value
          : "";
    const placeholder =
      typeof field.default === "number" ? String(field.default) : "";
    return (
      <div className={styles.pluginSettingRow}>
        <div className={styles.pluginSettingNumberWrap}>
          <div className={styles.pluginSettingLabel}>{field.label}</div>
          {field.description && (
            <div className={styles.envErrorHint}>{field.description}</div>
          )}
          <div className={styles.pluginSettingNumberRow}>
            <input
              type="number"
              value={numericValue}
              placeholder={placeholder}
              min={field.min ?? undefined}
              max={field.max ?? undefined}
              step={field.step ?? undefined}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw.trim() === "") {
                  onChange(null);
                  return;
                }
                const n = Number(raw);
                // The runtime accepts both numbers and numeric strings
                // — sending the parsed number when valid keeps the
                // wire payload tight; an unparseable value is left as
                // a string so the user can still see what they typed
                // (the runtime will fall back to the default).
                if (Number.isFinite(n)) {
                  onChange(n);
                } else {
                  onChange(raw);
                }
              }}
              className={styles.numberInput}
            />
            {field.unit && (
              <span className={styles.pluginSettingUnit}>{field.unit}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // select
  const stringValue = typeof value === "string" ? value : (field.default ?? "");
  return (
    <div className={styles.pluginSettingRow}>
      <div>
        <div className={styles.pluginSettingLabel}>{field.label}</div>
        {field.description && (
          <div className={styles.envErrorHint}>{field.description}</div>
        )}
        <select
          value={stringValue}
          onChange={(e) => onChange(e.target.value || null)}
          className={styles.textInput}
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
