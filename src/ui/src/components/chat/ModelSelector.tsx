import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleDollarSign, ChevronRight } from "lucide-react";
import styles from "./ModelSelector.module.css";
import { MODELS, type Model } from "./modelRegistry";
import { useAppStore } from "../../stores/useAppStore";

export { MODELS, is1mContextModel, get1mFallback } from "./modelRegistry";

interface ModelSelectorProps {
  selected: string;
  onSelect: (model: string) => void;
  onClose: () => void;
}

export function ModelSelector({
  selected,
  onSelect,
  onClose,
}: ModelSelectorProps) {
  const { t } = useTranslation("chat");
  const disable1mContext = useAppStore((s) => s.disable1mContext);
  const visibleModels = disable1mContext
    ? MODELS.filter((m) => m.contextWindowTokens < 1_000_000)
    : MODELS;
  const primary = visibleModels.filter((m) => !m.legacy);
  const legacy = visibleModels.filter((m) => m.legacy);
  const selectedIsLegacy = legacy.some((m) => m.id === selected);

  const [moreOpen, setMoreOpen] = useState(selectedIsLegacy);

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

  const primaryGroups = new Map<string, Model[]>();
  for (const model of primary) {
    const list = primaryGroups.get(model.group) ?? [];
    list.push(model);
    primaryGroups.set(model.group, list);
  }

  return (
    <>
      <div className={styles.overlay} onClick={onClose} />
      <div className={styles.dropdown}>
        {[...primaryGroups.entries()].map(([group, models]) => (
          <div key={group}>
            <div className={styles.groupLabel}>{group}</div>
            {models.map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                selected={model.id === selected}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
        {legacy.length > 0 && (
          <>
            <button
              type="button"
              className={`${styles.item} ${styles.moreToggle}`}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              {t("more_models")}
              <ChevronRight
                size={14}
                className={`${styles.chevron} ${moreOpen ? styles.chevronOpen : ""}`}
              />
            </button>
            {moreOpen && (
              <div>
                {legacy.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    selected={model.id === selected}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: Model;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <button
      type="button"
      className={`${styles.item} ${selected ? styles.itemSelected : ""}`}
      onClick={() => onSelect(model.id)}
    >
      <span className={styles.dot} />
      {model.label}
      {model.extraUsage && (
        <span
          className={styles.extraUsage}
          title={t("mcp_extra_usage_tip")}
        >
          <CircleDollarSign size={14} />
        </span>
      )}
      {selected && <span className={styles.check}>✓</span>}
    </button>
  );
}
