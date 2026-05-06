import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../modals/Modal";
import shared from "../modals/shared.module.css";
import { displayNameForPath, type FileContextTarget } from "./fileContextMenu";

interface RenamePathDialogProps {
  target: FileContextTarget;
  dirtyCount: number;
  loading: boolean;
  error: string | null;
  onConfirm: (name: string) => void;
  onClose: () => void;
}

function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required.";
  if (trimmed === "." || trimmed === "..") return "That name is reserved.";
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return "Name cannot contain path separators.";
  }
  return null;
}

export function RenamePathDialog({
  target,
  dirtyCount,
  loading,
  error,
  onConfirm,
  onClose,
}: RenamePathDialogProps) {
  const originalName = useMemo(() => displayNameForPath(target.path), [target.path]);
  const [draft, setDraft] = useState(originalName);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const validationError = validateName(draft);
  const unchanged = draft.trim() === originalName;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <Modal title={`Rename ${target.isDirectory ? "folder" : "file"}`} onClose={onClose}>
      {dirtyCount > 0 && (
        <div className={shared.warning}>
          Unsaved changes in {dirtyCount === 1 ? "this file" : `${dirtyCount} files`} will
          move to the renamed path.
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (validationError || unchanged || loading) return;
          onConfirm(draft.trim());
        }}
      >
        <label className={shared.label} htmlFor="rename-path-input">
          Name
        </label>
        <input
          ref={inputRef}
          id="rename-path-input"
          className={shared.input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={loading}
        />
        {(validationError || error) && (
          <div className={shared.error}>{validationError ?? error}</div>
        )}
        <div className={shared.actions}>
          <button type="button" className={shared.btn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="submit"
            className={shared.btnPrimary}
            disabled={!!validationError || unchanged || loading}
          >
            {loading ? "Renaming…" : "Rename"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
