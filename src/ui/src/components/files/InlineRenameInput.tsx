import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { validatePathName } from "./fileContextMenu";

interface InlineRenameInputProps {
  name: string;
  className: string;
  ariaLabel: string;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}

export function InlineRenameInput({
  name,
  className,
  ariaLabel,
  onCommit,
  onCancel,
}: InlineRenameInputProps) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const commitInFlightRef = useRef(false);

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const commit = async () => {
    if (commitInFlightRef.current) return;
    const next = draft.trim();
    if (next === name) {
      onCancel();
      return;
    }
    const validationError = validatePathName(next);
    if (validationError) {
      setError(validationError);
      return;
    }
    commitInFlightRef.current = true;
    let ok = false;
    try {
      ok = await onCommit(next);
    } catch (err) {
      console.error("Failed to commit inline file name:", err);
    } finally {
      commitInFlightRef.current = false;
    }
    if (!ok) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      className={className}
      value={draft}
      title={error ?? undefined}
      aria-label={ariaLabel}
      aria-invalid={error ? true : undefined}
      onChange={(event) => {
        setDraft(event.target.value);
        setError(null);
      }}
      onBlur={() => void commit()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    />
  );
}
