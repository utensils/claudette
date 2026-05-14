/**
 * Mirrors the Rust `RepositoryInputField` enum (`src/model/repository_input.rs`).
 *
 * Shape intentionally parallel to `PluginSettingField` so we can hand instances
 * off to the shared `PluginSettingInput` renderer with a tiny adapter (see
 * `toPluginSettingField`). The only divergence is the `string` vs `text`
 * discriminant — the user-facing wording is "string" and the wire stays
 * stable; the renderer just needs to know they're the same shape.
 */
import type { PluginSettingField } from "./claudettePlugins";

export type RepositoryInputField =
  | {
      type: "boolean";
      key: string;
      label: string;
      description?: string | null;
      default?: boolean | null;
    }
  | {
      type: "string";
      key: string;
      label: string;
      description?: string | null;
      default?: string | null;
      placeholder?: string | null;
    }
  | {
      type: "number";
      key: string;
      label: string;
      description?: string | null;
      default?: number | null;
      min?: number | null;
      max?: number | null;
      step?: number | null;
      unit?: string | null;
    };

export type RepositoryInputType = RepositoryInputField["type"];

/** Stringly-coerced map shape persisted on a workspace at create time. */
export type RepositoryInputValues = Record<string, string>;

/** Validates that `key` is a POSIX-ish env var name. Mirrors the backend
 *  validator in `src/model/repository_input.rs::validate_input_key` so the
 *  client rejects bad names before a network round-trip. Returns null on
 *  success or a human-readable reason on failure.
 */
export function validateInputKey(key: string): string | null {
  if (key.length === 0) return "Input name cannot be empty.";
  const first = key.charCodeAt(0);
  const isAlpha =
    (first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95;
  if (!isAlpha) {
    return `Input name "${key}" must start with a letter or underscore.`;
  }
  for (let i = 1; i < key.length; i++) {
    const c = key.charCodeAt(i);
    const ok =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      c === 95;
    if (!ok) {
      return `Input name "${key}" can only contain letters, digits, and underscores.`;
    }
  }
  return null;
}

/** Coerce a user-supplied value against its field's type. Returns the
 *  canonicalized string to send to the backend, or a human-readable error.
 *  Mirrors `coerce_value` in `src/model/repository_input.rs` — the backend
 *  re-validates, so this is purely for fast UI feedback.
 */
export function coerceInputValue(
  field: RepositoryInputField,
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  switch (field.type) {
    case "boolean":
      if (raw === "true" || raw === "false") return { ok: true, value: raw };
      return {
        ok: false,
        error: `"${field.label}" must be true or false.`,
      };
    case "number": {
      const trimmed = raw.trim();
      if (trimmed === "") {
        return { ok: false, error: `"${field.label}" is required.` };
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        return {
          ok: false,
          error: `"${field.label}" must be a number.`,
        };
      }
      if (typeof field.min === "number" && n < field.min) {
        return { ok: false, error: `"${field.label}" must be ≥ ${field.min}.` };
      }
      if (typeof field.max === "number" && n > field.max) {
        return { ok: false, error: `"${field.label}" must be ≤ ${field.max}.` };
      }
      return { ok: true, value: trimmed };
    }
    case "string":
      // String inputs always have *some* requirement (the schema field is
      // declared = the workspace must supply a value). Empty trims block.
      if (raw.trim() === "") {
        return { ok: false, error: `"${field.label}" is required.` };
      }
      return { ok: true, value: raw };
  }
}

/** Adapt a `RepositoryInputField` to the `PluginSettingField` shape so the
 *  shared `PluginSettingInput` component can render it. Maps `string → text`
 *  (the only structural difference) and drops the boolean `default` null
 *  variant to undefined so the renderer's existing logic applies cleanly.
 */
export function toPluginSettingField(
  field: RepositoryInputField,
): PluginSettingField {
  switch (field.type) {
    case "boolean":
      return {
        type: "boolean",
        key: field.key,
        label: field.label,
        description: field.description ?? null,
        default: field.default ?? false,
      };
    case "string":
      return {
        type: "text",
        key: field.key,
        label: field.label,
        description: field.description ?? null,
        default: field.default ?? null,
        placeholder: field.placeholder ?? null,
      };
    case "number":
      return {
        type: "number",
        key: field.key,
        label: field.label,
        description: field.description ?? null,
        default: field.default ?? null,
        min: field.min ?? null,
        max: field.max ?? null,
        step: field.step ?? null,
        unit: field.unit ?? null,
      };
  }
}
