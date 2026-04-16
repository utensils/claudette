import { useEffect, useRef } from "react";
import { isXhighEffortAllowed, isMaxEffortAllowed } from "./modelCapabilities";
import styles from "./ModelSelector.module.css";

export const EFFORT_LEVELS = [
  { id: "auto", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;

/** Return the effort levels available for the given model. */
function getAvailableLevels(model: string) {
  if (isXhighEffortAllowed(model)) return EFFORT_LEVELS;
  if (isMaxEffortAllowed(model)) return EFFORT_LEVELS.filter((l) => l.id !== "xhigh");
  return EFFORT_LEVELS.filter((l) => l.id !== "xhigh" && l.id !== "max");
}

interface EffortSelectorProps {
  selected: string;
  selectedModel: string;
  onSelect: (level: string) => void;
  onClose: () => void;
}

export function EffortSelector({
  selected,
  selectedModel,
  onSelect,
  onClose,
}: EffortSelectorProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const levels = getAvailableLevels(selectedModel);

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
        <div className={styles.groupLabel}>Effort</div>
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
