import { useEffect, useRef, type RefObject } from "react";
import { BadgeDollarSign } from "lucide-react";
import styles from "./ModelSelector.module.css";
import { MODELS } from "./modelRegistry";

export { MODELS } from "./modelRegistry";

interface ModelSelectorProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  selected: string;
  onSelect: (model: string) => void;
  onClose: () => void;
}

export function ModelSelector({
  selected,
  onSelect,
  onClose,
}: ModelSelectorProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close on Escape.
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

  // Group models.
  const groups = new Map<string, typeof MODELS[number][]>();
  for (const model of MODELS) {
    const list = groups.get(model.group) ?? [];
    list.push(model);
    groups.set(model.group, list);
  }

  return (
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div ref={dropdownRef} className={styles.dropdown}>
        {[...groups.entries()].map(([group, models]) => (
          <div key={group}>
            <div className={styles.groupLabel}>{group}</div>
            {models.map((model) => (
              <button
                key={model.id}
                className={`${styles.item} ${model.id === selected ? styles.itemSelected : ""}`}
                onClick={() => onSelect(model.id)}
              >
                <span className={styles.dot} />
                {model.label}
                {model.extraUsage && (
                  <span
                    className={styles.extraUsage}
                    title="Extra usage: 1M context requests are billed at API rates beyond your subscription plan allocation"
                  >
                    <BadgeDollarSign size={14} />
                  </span>
                )}
                {model.id === selected && <span className={styles.check}>✓</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
