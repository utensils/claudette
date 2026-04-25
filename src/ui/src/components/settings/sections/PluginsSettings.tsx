import { useCallback, useEffect, useState } from "react";
import {
  listBuiltinClaudettePlugins,
  listClaudettePlugins,
  reseedBundledPlugins,
  setBuiltinClaudettePluginEnabled,
  setClaudettePluginEnabled,
  setClaudettePluginSetting,
  type BuiltinPluginInfo,
} from "../../../services/claudettePlugins";
import type {
  ClaudettePluginInfo,
  ClaudettePluginKind,
  PluginSettingField,
} from "../../../types/claudettePlugins";
import styles from "../Settings.module.css";

const KIND_LABELS: Record<ClaudettePluginKind, string> = {
  scm: "Source control",
  "env-provider": "Environment providers",
};

const KIND_ORDER: ClaudettePluginKind[] = ["scm", "env-provider"];

/**
 * Plugins settings section — shows Claudette's own Lua plugins (SCM
 * providers + env providers) with global enable/disable toggles and
 * per-plugin setting forms.
 *
 * Distinct from the "Claude Code Plugins" section, which manages
 * the Claude Code marketplace. These plugins are bundled with
 * Claudette (or dropped into `~/.claudette/plugins/`) and run inside
 * Claudette's sandboxed Lua VM.
 */
export function PluginsSettings() {
  const [plugins, setPlugins] = useState<ClaudettePluginInfo[] | null>(null);
  const [builtins, setBuiltins] = useState<BuiltinPluginInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reseedMessage, setReseedMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [luaResult, builtinResult] = await Promise.all([
        listClaudettePlugins(),
        listBuiltinClaudettePlugins(),
      ]);
      setPlugins(luaResult);
      setBuiltins(builtinResult);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleToggleBuiltin = useCallback(
    async (pluginName: string, nextEnabled: boolean) => {
      try {
        await setBuiltinClaudettePluginEnabled(pluginName, nextEnabled);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleExpanded = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleToggle = useCallback(
    async (pluginName: string, nextEnabled: boolean) => {
      try {
        await setClaudettePluginEnabled(pluginName, nextEnabled);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  const handleSettingChange = useCallback(
    async (pluginName: string, key: string, value: unknown) => {
      try {
        await setClaudettePluginSetting(pluginName, key, value);
        await refresh();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh],
  );

  const handleReseed = useCallback(async () => {
    setReseedMessage(null);
    try {
      const warnings = await reseedBundledPlugins();
      setReseedMessage(
        warnings.length === 0
          ? "Bundled plugins reseeded."
          : `Reseeded with ${warnings.length} warning(s): ${warnings.join("; ")}`,
      );
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }, [refresh]);

  if (error) {
    return (
      <div>
        <h2 className={styles.sectionTitle}>Plugins</h2>
        <div className={styles.mcpError} role="alert">
          Failed to load plugins: {error}
        </div>
      </div>
    );
  }

  if (loading && plugins === null) {
    return (
      <div>
        <h2 className={styles.sectionTitle}>Plugins</h2>
        <div className={styles.settingDescription}>Loading…</div>
      </div>
    );
  }

  const items = plugins ?? [];
  const grouped = KIND_ORDER.map((kind) => ({
    kind,
    items: items.filter((p) => p.kind === kind),
  })).filter((g) => g.items.length > 0);

  return (
    <div>
      <h2 className={styles.sectionTitle}>Plugins</h2>
      <div className={styles.settingDescription}>
        Claudette's built-in plugins — source-control providers and
        environment activators. Toggle a plugin off to disable it
        globally; open a row to configure its behaviour.{" "}
        <em>(Not to be confused with Claude Code Plugins, which manages
        marketplace extensions for the Claude CLI itself.)</em>
      </div>

      {builtins && builtins.length > 0 && (
        <div className={styles.fieldGroup}>
          <div className={styles.mcpGroupLabel}>Built-in Claudette plugins</div>
          <div className={styles.mcpList}>
            {builtins.map((p) => {
              // Namespace the expanded key so a future Lua plugin named the
              // same as a built-in can't accidentally co-toggle.
              const key = `builtin:${p.name}`;
              return (
                <BuiltinPluginRow
                  key={p.name}
                  plugin={p}
                  expanded={expanded.has(key)}
                  onToggleExpand={() => toggleExpanded(key)}
                  onToggleEnabled={(next) => handleToggleBuiltin(p.name, next)}
                />
              );
            })}
          </div>
        </div>
      )}

      {grouped.length === 0 && (
        <div className={styles.settingDescription}>
          No plugins discovered. This shouldn't happen — bundled plugins
          are seeded on first run. Try the Reseed button below.
        </div>
      )}

      {grouped.map(({ kind, items }) => (
        <div key={kind} className={styles.fieldGroup}>
          <div className={styles.mcpGroupLabel}>{KIND_LABELS[kind]}</div>
          <div className={styles.mcpList}>
            {items.map((plugin) => (
              <PluginRow
                key={plugin.name}
                plugin={plugin}
                expanded={expanded.has(plugin.name)}
                onToggleExpand={() => toggleExpanded(plugin.name)}
                onToggleEnabled={(next) => handleToggle(plugin.name, next)}
                onSettingChange={(key, value) =>
                  handleSettingChange(plugin.name, key, value)
                }
              />
            ))}
          </div>
        </div>
      ))}

      <div className={styles.buttonRow}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={handleReseed}
        >
          Reload bundled plugins
        </button>
        {reseedMessage && (
          <span className={styles.settingDescription}>{reseedMessage}</span>
        )}
      </div>
    </div>
  );
}

interface PluginRowProps {
  plugin: ClaudettePluginInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onSettingChange: (key: string, value: unknown) => void;
}

function PluginRow({
  plugin,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onSettingChange,
}: PluginRowProps) {
  const hasSettings = plugin.settings_schema.length > 0;
  const hasCliIssue = !plugin.cli_available;
  const dotColor = !plugin.enabled
    ? "var(--text-faint)"
    : hasCliIssue
      ? "var(--status-stopped)"
      : "var(--status-running)";
  const badge = !plugin.enabled
    ? "disabled"
    : hasCliIssue
      ? "cli missing"
      : "loaded";

  return (
    <div>
      <div className={styles.mcpRow}>
        <div className={styles.mcpInfo}>
          <span
            className={styles.mcpStatusDot}
            style={{ background: dotColor }}
            title={badge}
          />
          <span
            className={`${styles.mcpName} ${!plugin.enabled ? styles.mcpNameDisabled : ""}`}
          >
            {plugin.display_name}
          </span>
          <span className={styles.mcpBadge}>{badge}</span>
          <span className={styles.settingDescription}>
            v{plugin.version}
          </span>
        </div>
        <div className={styles.mcpActions}>
          {(hasSettings || hasCliIssue) && (
            <button
              type="button"
              className={styles.envDetailsBtn}
              onClick={onToggleExpand}
              aria-expanded={expanded}
            >
              {expanded ? "Hide details" : "Details"}
            </button>
          )}
          <button
            type="button"
            className={`${styles.mcpToggle} ${plugin.enabled ? styles.mcpToggleOn : ""}`}
            onClick={() => onToggleEnabled(!plugin.enabled)}
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.display_name}`}
          >
            <span className={styles.mcpToggleKnob} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className={styles.envErrorCard}>
          <div className={styles.settingDescription}>
            {plugin.description}
          </div>
          {plugin.required_clis.length > 0 && (
            <div className={styles.envErrorHint}>
              Requires:{" "}
              {plugin.required_clis.map((cli, i) => (
                <span key={cli}>
                  {i > 0 && ", "}
                  <code>{cli}</code>
                </span>
              ))}
              {hasCliIssue && (
                <>
                  {" "}
                  <strong style={{ color: "var(--status-stopped)" }}>
                    (not found on PATH)
                  </strong>
                </>
              )}
            </div>
          )}
          {hasSettings && (
            <div className={styles.pluginSettingsForm}>
              {plugin.settings_schema.map((field) => (
                <SettingInput
                  key={field.key}
                  field={field}
                  value={plugin.setting_values[field.key]}
                  onChange={(value) => onSettingChange(field.key, value)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SettingInput({
  field,
  value,
  onChange,
}: {
  field: PluginSettingField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
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

/**
 * Row for a built-in (Rust-implemented) Claudette plugin. Simpler than the
 * Lua plugin row because there's no manifest, no setting fields, no CLI
 * dependency — just a description (behind a Details toggle, matching the
 * Lua-plugin row layout) and an enable/disable switch.
 */
interface BuiltinPluginRowProps {
  plugin: BuiltinPluginInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}

export function BuiltinPluginRow({
  plugin,
  expanded,
  onToggleExpand,
  onToggleEnabled,
}: BuiltinPluginRowProps) {
  const dotColor = plugin.enabled
    ? "var(--status-running)"
    : "var(--text-faint)";
  const badge = plugin.enabled ? "loaded" : "disabled";
  return (
    <div>
      <div className={styles.mcpRow}>
        <div className={styles.mcpInfo}>
          <span
            className={styles.mcpStatusDot}
            style={{ background: dotColor }}
            title={badge}
          />
          <span
            className={`${styles.mcpName} ${!plugin.enabled ? styles.mcpNameDisabled : ""}`}
          >
            {plugin.title}
          </span>
          <span className={styles.mcpBadge}>{badge}</span>
        </div>
        <div className={styles.mcpActions}>
          <button
            type="button"
            className={styles.envDetailsBtn}
            onClick={onToggleExpand}
            aria-expanded={expanded}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
          <button
            type="button"
            className={`${styles.mcpToggle} ${plugin.enabled ? styles.mcpToggleOn : ""}`}
            onClick={() => onToggleEnabled(!plugin.enabled)}
            role="switch"
            aria-checked={plugin.enabled}
            aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.title}`}
          >
            <span className={styles.mcpToggleKnob} />
          </button>
        </div>
      </div>
      {expanded && (
        <div className={styles.envErrorCard}>
          <div className={styles.settingDescription}>{plugin.description}</div>
        </div>
      )}
    </div>
  );
}
