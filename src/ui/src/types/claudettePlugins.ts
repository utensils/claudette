/**
 * Types for Claudette's own Lua plugins (SCM providers + env
 * providers). Distinct from the Claude Code marketplace plugins in
 * `src/ui/src/types/plugins.ts`.
 */

export type ClaudettePluginKind = "scm" | "env-provider";

/**
 * Mirrors the Rust `PluginSettingField` enum. The `type` discriminant
 * tells the UI which input to render.
 */
export type PluginSettingField =
  | {
      type: "boolean";
      key: string;
      label: string;
      description?: string | null;
      default?: boolean;
    }
  | {
      type: "text";
      key: string;
      label: string;
      description?: string | null;
      default?: string | null;
      placeholder?: string | null;
    }
  | {
      type: "select";
      key: string;
      label: string;
      description?: string | null;
      default?: string | null;
      options: Array<{ value: string; label: string }>;
    };

export interface ClaudettePluginInfo {
  name: string;
  display_name: string;
  version: string;
  description: string;
  kind: ClaudettePluginKind;
  required_clis: string[];
  /** `false` when a required CLI (e.g. `direnv`) isn't on PATH. */
  cli_available: boolean;
  /** `true` unless the user has globally disabled this plugin. */
  enabled: boolean;
  settings_schema: PluginSettingField[];
  /**
   * Current effective value for each declared setting key, after
   * merging manifest defaults + user overrides. Missing/unset values
   * are `null`.
   */
  setting_values: Record<string, unknown>;
}
