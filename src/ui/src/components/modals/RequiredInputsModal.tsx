/**
 * Workspace-create prompt for repos that declare required inputs.
 *
 * Opens before `createWorkspace` is invoked, collects a value for every
 * declared field, and resolves a promise the orchestration hook is awaiting.
 * Validates client-side (type + bounds) so users see errors instantly; the
 * backend re-validates on receive.
 *
 * Wire-up:
 *   - `promptRequiredInputsIfDeclared` opens the modal with `{ schema,
 *     repoName, resolve }` and `await`s the promise.
 *   - This modal calls `resolve(values | null)` on submit / cancel and
 *     closes itself.
 *
 * Field layout: each row is `[Label (ENV_NAME)] [input]` — see
 * `RequiredInputsModal.module.css` for the rationale (compact-form modals
 * read better with adjacent labels than with the stacked layout we use in
 * the settings panel).
 */
import { useCallback, useId, useMemo, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  coerceInputValue,
  type RepositoryInputField,
} from "../../types/repositoryInput";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./RequiredInputsModal.module.css";

type ResolveFn = (values: Record<string, string> | null) => void;

interface ModalState {
  schema: RepositoryInputField[];
  repoName: string;
  resolve: ResolveFn;
}

function readModalState(data: Record<string, unknown>): ModalState | null {
  const { schema, repoName, resolve } = data;
  if (!Array.isArray(schema)) return null;
  if (typeof resolve !== "function") return null;
  return {
    schema: schema as RepositoryInputField[],
    repoName: typeof repoName === "string" ? repoName : "",
    resolve: resolve as ResolveFn,
  };
}

/** Initial field values: prefer the declared default, otherwise an empty
 *  string. Stored as strings throughout since the wire shape to the backend
 *  is `Record<string, string>`. */
function defaultValuesFor(
  schema: RepositoryInputField[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of schema) {
    switch (field.type) {
      case "boolean":
        out[field.key] = field.default ? "true" : "false";
        break;
      case "string":
        out[field.key] = field.default ?? "";
        break;
      case "number":
        out[field.key] =
          typeof field.default === "number" ? String(field.default) : "";
        break;
    }
  }
  return out;
}

export function RequiredInputsModal() {
  const modalData = useAppStore((s) => s.modalData);
  const closeModal = useAppStore((s) => s.closeModal);

  const state = readModalState(modalData);
  const initial = useMemo(
    () => (state ? defaultValuesFor(state.schema) : {}),
    [state],
  );
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [submitted, setSubmitted] = useState(false);

  const setValue = useCallback((key: string, raw: string) => {
    setValues((prev) => ({ ...prev, [key]: raw }));
  }, []);

  // Bail when the modal payload is malformed. closeModal() races React's
  // render scheduler when the user mashes Escape twice in a row.
  if (!state) {
    return null;
  }

  // Per-field errors recomputed each render (cheap — handful of fields).
  // Only surface them after the user has tried to submit so the modal
  // opens clean.
  const errors: Record<string, string | null> = {};
  for (const field of state.schema) {
    const raw = values[field.key] ?? "";
    const result = coerceInputValue(field, raw);
    errors[field.key] = result.ok ? null : result.error;
  }
  const firstError = state.schema
    .map((f) => errors[f.key])
    .find((e): e is string => typeof e === "string");

  const submit = () => {
    setSubmitted(true);
    if (firstError) return;
    const coerced: Record<string, string> = {};
    for (const field of state.schema) {
      const raw = values[field.key] ?? "";
      const result = coerceInputValue(field, raw);
      if (!result.ok) return;
      coerced[field.key] = result.value;
    }
    state.resolve(coerced);
    closeModal();
  };

  const cancel = () => {
    state.resolve(null);
    closeModal();
  };

  const title = state.repoName
    ? `Configure new workspace — ${state.repoName}`
    : "Configure new workspace";

  return (
    <Modal title={title} onClose={cancel} wide>
      <div className={shared.warning}>
        This repo declares inputs that every new workspace needs. They&apos;ll
        become environment variables for the agent, terminal, and scripts.
      </div>
      <div className={styles.fields}>
        {state.schema.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            value={values[field.key] ?? ""}
            onChange={(raw) => setValue(field.key, raw)}
            error={submitted ? errors[field.key] : null}
          />
        ))}
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={cancel} type="button">
          Cancel
        </button>
        <button
          className={shared.btnPrimary}
          onClick={submit}
          type="button"
          disabled={submitted && firstError !== undefined}
        >
          Create workspace
        </button>
      </div>
    </Modal>
  );
}

interface FieldRowProps {
  field: RepositoryInputField;
  value: string;
  onChange: (raw: string) => void;
  error: string | null;
}

/** Single labeled row in the prompt — every field type uses the same
 *  two-column layout (label left, control right) so the form is visually
 *  consistent. The toggle sits at the left edge of the control column, the
 *  same place text/number inputs start. */
function FieldRow({ field, value, onChange, error }: FieldRowProps) {
  const inputId = useId();
  const checked = field.type === "boolean" && value === "true";

  return (
    <div>
      <div className={styles.fieldRow}>
        <FieldLabel
          field={field}
          // The toggle is a `<button>`, not an `<input>` — `htmlFor`
          // wouldn't move focus to it. Drop the association for booleans
          // and rely on the toggle's `aria-label` instead.
          htmlFor={field.type === "boolean" ? undefined : inputId}
        />
        <div className={styles.control}>
          {field.type === "boolean" && (
            <button
              type="button"
              role="switch"
              aria-checked={checked}
              aria-label={field.label}
              className={`${styles.toggle} ${checked ? styles.toggleOn : ""}`}
              onClick={() => onChange(checked ? "false" : "true")}
            >
              <span className={styles.toggleKnob} />
            </button>
          )}
          {field.type === "number" && (
            <input
              id={inputId}
              type="number"
              className={styles.numberInput}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={
                typeof field.default === "number"
                  ? String(field.default)
                  : undefined
              }
              min={field.min ?? undefined}
              max={field.max ?? undefined}
              step={field.step ?? undefined}
            />
          )}
          {field.type === "string" && (
            <input
              id={inputId}
              type="text"
              className={styles.input}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={field.placeholder ?? undefined}
            />
          )}
        </div>
      </div>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}

interface FieldLabelProps {
  field: RepositoryInputField;
  htmlFor: string | undefined;
}

/** Two-line label: the human label + env-key in parens up top, optional
 *  description below in a smaller muted font. The env key is in mono so it
 *  visually reads as the identifier the agent/scripts will see. */
function FieldLabel({ field, htmlFor }: FieldLabelProps) {
  return (
    <label className={styles.labelGroup} htmlFor={htmlFor}>
      <span className={styles.labelText}>
        {field.label} <span className={styles.envKey}>({field.key})</span>
      </span>
      {field.description && (
        <span className={styles.description}>{field.description}</span>
      )}
    </label>
  );
}
