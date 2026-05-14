/**
 * Per-repo "required inputs" schema editor. Each field declares a name (used
 * as the env var key for the workspace session), a type (boolean / string /
 * number) used for client-side validation in the workspace-create modal, an
 * optional label/description for the prompt, and — for number — optional
 * min/max bounds.
 *
 * Saves through the dedicated `update_repository_required_inputs` Tauri
 * command. Lives outside `RepoSettings.tsx` because that file is already a
 * god file per CLAUDE.md — keeping new declarative editors as their own
 * components stops the trend.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { updateRepositoryRequiredInputs } from "../../../services/tauri";
import { useAppStore } from "../../../stores/useAppStore";
import {
  validateInputKey,
  type RepositoryInputField,
  type RepositoryInputType,
} from "../../../types/repositoryInput";
import styles from "../Settings.module.css";

interface RequiredInputsEditorProps {
  repoId: string;
}

/** Local row shape — keeps non-discriminated extras around so toggling type
 *  doesn't lose what the user typed for number bounds (etc). The serialize
 *  step on save trims to the type-relevant fields. */
interface EditorRow {
  /** UI-only identifier — survives row deletion/reorder without colliding
   *  with the user-editable `key` field. */
  rowId: string;
  key: string;
  type: RepositoryInputType;
  label: string;
  description: string;
  placeholder: string;
  defaultBool: boolean;
  defaultString: string;
  defaultNumber: string;
  min: string;
  max: string;
}

function blankRow(): EditorRow {
  return {
    rowId: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `row-${Math.random().toString(36).slice(2)}`,
    key: "",
    type: "string",
    label: "",
    description: "",
    placeholder: "",
    defaultBool: false,
    defaultString: "",
    defaultNumber: "",
    min: "",
    max: "",
  };
}

function rowFromField(field: RepositoryInputField): EditorRow {
  const base = blankRow();
  base.key = field.key;
  base.label = field.label;
  base.description = field.description ?? "";
  base.type = field.type;
  switch (field.type) {
    case "boolean":
      base.defaultBool = field.default ?? false;
      break;
    case "string":
      base.defaultString = field.default ?? "";
      base.placeholder = field.placeholder ?? "";
      break;
    case "number":
      base.defaultNumber =
        typeof field.default === "number" ? String(field.default) : "";
      base.min = typeof field.min === "number" ? String(field.min) : "";
      base.max = typeof field.max === "number" ? String(field.max) : "";
      break;
  }
  return base;
}

/** Convert a row to the wire shape, returning either the field or an inline
 *  reason it's not yet savable. Empty labels fall back to the key so the
 *  workspace-create modal always has *something* to render as the prompt
 *  label.
 */
function rowToField(
  row: EditorRow,
): { ok: true; field: RepositoryInputField } | { ok: false; error: string } {
  const keyErr = validateInputKey(row.key.trim());
  if (keyErr) return { ok: false, error: keyErr };
  const key = row.key.trim();
  const label = row.label.trim() || key;
  const description = row.description.trim() || null;
  switch (row.type) {
    case "boolean":
      return {
        ok: true,
        field: {
          type: "boolean",
          key,
          label,
          description,
          default: row.defaultBool,
        },
      };
    case "string":
      return {
        ok: true,
        field: {
          type: "string",
          key,
          label,
          description,
          default: row.defaultString.trim() || null,
          placeholder: row.placeholder.trim() || null,
        },
      };
    case "number": {
      const parseOptional = (s: string): number | null => {
        const t = s.trim();
        if (t === "") return null;
        const n = Number(t);
        return Number.isFinite(n) ? n : NaN;
      };
      const defaultN = parseOptional(row.defaultNumber);
      const minN = parseOptional(row.min);
      const maxN = parseOptional(row.max);
      if (Number.isNaN(defaultN as number)) {
        return { ok: false, error: `"${label}": default must be a number.` };
      }
      if (Number.isNaN(minN as number)) {
        return { ok: false, error: `"${label}": min must be a number.` };
      }
      if (Number.isNaN(maxN as number)) {
        return { ok: false, error: `"${label}": max must be a number.` };
      }
      if (minN !== null && maxN !== null && minN > maxN) {
        return { ok: false, error: `"${label}": min must be ≤ max.` };
      }
      return {
        ok: true,
        field: {
          type: "number",
          key,
          label,
          description,
          default: defaultN,
          min: minN,
          max: maxN,
          step: null,
          unit: null,
        },
      };
    }
  }
}

export function RequiredInputsEditor({ repoId }: RequiredInputsEditorProps) {
  const repo = useAppStore((s) =>
    s.repositories.find((r) => r.id === repoId),
  );
  const updateRepo = useAppStore((s) => s.updateRepository);

  const [rows, setRows] = useState<EditorRow[]>(() =>
    (repo?.required_inputs ?? []).map(rowFromField),
  );
  const [error, setError] = useState<string | null>(null);

  // Reset local state when switching repos. We watch repoId, not `repo`, so
  // optimistic store updates from this editor don't churn the local rows.
  useEffect(() => {
    setRows((repo?.required_inputs ?? []).map(rowFromField));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId]);

  // Debounce save: ref-based so rapid edits within ~400ms coalesce into one
  // round-trip (matches the pattern used elsewhere in RepoSettings).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // `flushSave` takes the (repoId, rows) snapshot explicitly so the
  // queued timer can save against the data and target it was scheduled
  // with, not whatever is current at fire time. Without that, switching
  // repos within the debounce window would let the timer write the new
  // repo's rows back into the previous repo's `required_inputs` —
  // `rowsRef.current` gets reset by the repo-change effect, but the timer
  // still carries the previous repo id in its captured closure.
  const flushSave = useCallback(
    async (targetRepoId: string, rowsToSave: EditorRow[]) => {
      // Drop rows whose key is still empty — they're WIP placeholders the
      // user hasn't filled in yet. Surfacing a "key required" error for
      // those would be noisy on every keystroke.
      const candidates = rowsToSave.filter((r) => r.key.trim() !== "");
      const seen = new Set<string>();
      const fields: RepositoryInputField[] = [];
      for (const row of candidates) {
        const result = rowToField(row);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (seen.has(result.field.key)) {
          setError(`Duplicate input name "${result.field.key}".`);
          return;
        }
        seen.add(result.field.key);
        fields.push(result.field);
      }
      try {
        setError(null);
        await updateRepositoryRequiredInputs(targetRepoId, fields);
        updateRepo(targetRepoId, {
          required_inputs: fields.length === 0 ? null : fields,
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [updateRepo],
  );

  const queueSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Snapshot the target repo and rows at schedule time. The timer
    // callback uses these directly so a subsequent repo switch (which
    // resets `rowsRef.current` to the new repo's data) can't make the
    // pending save write the wrong rows to the wrong repo.
    const capturedRepoId = repoId;
    const capturedRows = rowsRef.current;
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void flushSave(capturedRepoId, capturedRows);
    }, 400);
  }, [flushSave, repoId]);

  // Flush on unmount so a quick edit + tab-switch doesn't lose changes.
  // We also flush on `repoId` change so the *previous* repo's pending
  // edits land before we switch — the timer is cleared either way.
  useEffect(() => {
    const previousRepoId = repoId;
    return () => {
      if (saveTimer.current !== null) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void flushSave(previousRepoId, rowsRef.current);
      }
    };
  }, [repoId, flushSave]);

  const updateRow = useCallback(
    (rowId: string, patch: Partial<EditorRow>) => {
      setRows((prev) =>
        prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
      );
      queueSave();
    },
    [queueSave],
  );

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, blankRow()]);
  }, []);

  const removeRow = useCallback(
    (rowId: string) => {
      setRows((prev) => prev.filter((r) => r.rowId !== rowId));
      queueSave();
    },
    [queueSave],
  );

  return (
    <div className={styles.fieldGroup}>
      <div className={styles.fieldLabel}>Required inputs</div>
      <div className={`${styles.fieldHint} ${styles.fieldHintSpaced}`}>
        Values new workspaces must supply before they're created. Each becomes
        an environment variable in the workspace session — visible to the
        agent, the terminal, and your setup/archive scripts.
      </div>

      {rows.length === 0 && (
        <div className={styles.fieldHint}>
          No required inputs declared. Workspaces in this repo will create
          immediately without prompting.
        </div>
      )}

      {rows.length > 0 && (
        <div className={styles.requiredInputsList}>
          {rows.map((row) => (
            <RequiredInputRow
              key={row.rowId}
              row={row}
              onChange={(patch) => updateRow(row.rowId, patch)}
              onRemove={() => removeRow(row.rowId)}
            />
          ))}
        </div>
      )}

      {error && <div className={styles.envErrorHint}>{error}</div>}

      <button
        type="button"
        className={styles.addPromptButton}
        onClick={addRow}
      >
        + Add required input
      </button>
    </div>
  );
}

interface RowProps {
  row: EditorRow;
  onChange: (patch: Partial<EditorRow>) => void;
  onRemove: () => void;
}

function RequiredInputRow({ row, onChange, onRemove }: RowProps) {
  const keyError = row.key.trim() === "" ? null : validateInputKey(row.key.trim());
  // Compose the base inline-field style with each input's role-specific
  // sizing class. `.requiredInputField` carries the visual chrome (border,
  // padding, font); the role class carries the flex-sizing rules.
  const field = styles.requiredInputField;
  const fullWidth = `${field} ${styles.requiredInputFullWidth}`;
  return (
    <div className={styles.requiredInputRow}>
      <div className={styles.requiredInputHeaderRow}>
        <input
          type="text"
          value={row.key}
          onChange={(e) => onChange({ key: e.target.value })}
          placeholder="EXAMPLE_ENV"
          className={`${field} ${styles.requiredInputKeyInput}`}
          aria-label="Input name (env var)"
        />
        <select
          value={row.type}
          onChange={(e) =>
            onChange({ type: e.target.value as RepositoryInputType })
          }
          className={`${field} ${styles.requiredInputTypeSelect}`}
          aria-label="Input type"
        >
          <option value="string">String</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
        </select>
        <button
          type="button"
          onClick={onRemove}
          className={styles.mcpRemoveBtn}
          aria-label="Remove input"
          title="Remove input"
        >
          ×
        </button>
      </div>
      {keyError && <div className={styles.envErrorHint}>{keyError}</div>}
      <input
        type="text"
        value={row.label}
        onChange={(e) => onChange({ label: e.target.value })}
        placeholder="Label (shown in the workspace-create prompt)"
        className={fullWidth}
        aria-label="Prompt label"
      />
      <input
        type="text"
        value={row.description}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="Description (optional)"
        className={fullWidth}
        aria-label="Description"
      />
      {row.type === "string" && (
        <input
          type="text"
          value={row.placeholder}
          onChange={(e) => onChange({ placeholder: e.target.value })}
          placeholder="Placeholder (optional)"
          className={fullWidth}
          aria-label="Placeholder"
        />
      )}
      {row.type === "number" && (
        <div className={styles.requiredInputNumberRow}>
          <input
            type="number"
            value={row.min}
            onChange={(e) => onChange({ min: e.target.value })}
            placeholder="Min (optional)"
            className={`${field} ${styles.requiredInputNumberField}`}
            aria-label="Minimum"
          />
          <input
            type="number"
            value={row.max}
            onChange={(e) => onChange({ max: e.target.value })}
            placeholder="Max (optional)"
            className={`${field} ${styles.requiredInputNumberField}`}
            aria-label="Maximum"
          />
          <input
            type="number"
            value={row.defaultNumber}
            onChange={(e) => onChange({ defaultNumber: e.target.value })}
            placeholder="Default (optional)"
            className={`${field} ${styles.requiredInputNumberField}`}
            aria-label="Default value"
          />
        </div>
      )}
      {row.type === "boolean" && (
        <label className={styles.autoRunLabel}>
          <input
            type="checkbox"
            checked={row.defaultBool}
            onChange={(e) => onChange({ defaultBool: e.target.checked })}
          />
          Default to enabled
        </label>
      )}
    </div>
  );
}
