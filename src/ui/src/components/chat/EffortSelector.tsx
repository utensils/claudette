import { useEffect, useRef } from "react";
import {
  getReasoningLevels,
  type ReasoningControlVariant,
} from "./reasoningControls";
import styles from "./ModelSelector.module.css";

export { CLAUDE_EFFORT_LEVELS as EFFORT_LEVELS } from "./reasoningControls";

interface EffortSelectorProps {
  selected: string;
  selectedModel: string;
  variant?: ReasoningControlVariant;
  label?: string;
  onSelect: (level: string) => void;
  onClose: () => void;
}

export function EffortSelector({
  selected,
  selectedModel,
  variant = "claude",
  label = "Effort",
  onSelect,
  onClose,
}: EffortSelectorProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const levels = getReasoningLevels(selectedModel, variant);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div ref={dropdownRef} className={styles.dropdown}>
        <div className={styles.groupLabel}>{label}</div>
        {levels.map((level) => (
          <button
            key={level.id}
            className={`${styles.item} ${level.id === selected ? styles.itemSelected : ""}`}
            onClick={() => onSelect(level.id)}
          >
            <span className={styles.dot} />
            {level.label}
            {level.id === selected && <span className={styles.check}>✓</span>}
          </button>
        ))}
      </div>
    </>
  );
}
