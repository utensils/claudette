import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, Eye, EyeOff, ChevronDown } from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import { setAppSetting } from "../../../services/tauri";
import { isEffortSupported } from "../modelCapabilities";
import {
  getReasoningLevels,
  normalizeReasoningLevel,
  reasoningLevelLabel,
  reasoningVariantForModel,
} from "../reasoningControls";
import { useSelectedModelEntry } from "../useSelectedModelEntry";
import styles from "./ReasoningPill.module.css";

interface ReasoningPillProps {
  sessionId: string;
  disabled: boolean;
}

export function ReasoningPill({ sessionId, disabled }: ReasoningPillProps) {
  const { t } = useTranslation("chat");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedModel = useAppStore((s) => s.selectedModel[sessionId] ?? "opus");
  const thinkingEnabled = useAppStore((s) => s.thinkingEnabled[sessionId] ?? false);
  const showThinkingBlocks = useAppStore((s) => s.showThinkingBlocks[sessionId] === true);
  const effortLevel = useAppStore((s) => s.effortLevel[sessionId] ?? "auto");
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setShowThinkingBlocks = useAppStore((s) => s.setShowThinkingBlocks);
  const setEffortLevel = useAppStore((s) => s.setEffortLevel);
  const currentModel = useSelectedModelEntry(sessionId);
  const reasoningVariant = reasoningVariantForModel(currentModel);
  const isCodex = reasoningVariant === "codex";
  const showEffort = currentModel?.supportsEffort ?? isEffortSupported(selectedModel);
  const normalizedEffort = normalizeReasoningLevel(
    effortLevel,
    selectedModel,
    reasoningVariant,
  );
  const effortLabel = reasoningLevelLabel(
    normalizedEffort,
    selectedModel,
    reasoningVariant,
  );
  const isActive = thinkingEnabled;

  const openDropdown = useCallback(() => {
    if (!disabled) setDropdownOpen(true);
  }, [disabled]);

  const toggleThinking = useCallback(async () => {
    const next = !thinkingEnabled;
    setThinkingEnabled(sessionId, next);
    await setAppSetting(`thinking_enabled:${sessionId}`, String(next));
  }, [sessionId, thinkingEnabled, setThinkingEnabled]);

  const toggleShowThinking = useCallback(async () => {
    const next = !showThinkingBlocks;
    setShowThinkingBlocks(sessionId, next);
    await setAppSetting(`show_thinking:${sessionId}`, String(next));
  }, [sessionId, showThinkingBlocks, setShowThinkingBlocks]);

  const handleEffortSelect = useCallback(
    async (level: string) => {
      setEffortLevel(sessionId, level);
      await setAppSetting(`effort_level:${sessionId}`, level);
      setDropdownOpen(false);
    },
    [sessionId, setEffortLevel],
  );

  useEffect(() => {
    if (!dropdownOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setDropdownOpen(false);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  const levels = getReasoningLevels(selectedModel, reasoningVariant);
  const reasoningSettingsLabel = isCodex
    ? t("codex_reasoning_settings")
    : t("reasoning_settings");
  const thinkingLabel = isCodex ? t("codex_reasoning_chip") : t("thinking_chip");
  const showThinkingLabel = isCodex ? t("codex_show_reasoning") : t("show_thinking");
  const effortGroupLabel = isCodex ? t("codex_reasoning_effort") : t("effort");
  const setEffortLabel = isCodex ? t("codex_set_reasoning_effort") : t("set_effort");

  return (
    <div ref={containerRef} className={styles.wrap}>
      <div className={`${styles.pill} ${isActive ? styles.pillActive : ""}`}>
        <button
          type="button"
          className={styles.segment}
          onClick={openDropdown}
          disabled={disabled}
          title={reasoningSettingsLabel}
          aria-expanded={dropdownOpen}
          aria-label={reasoningSettingsLabel}
        >
          <span className={styles.shortcutContent}>
            <Brain size={14} />
            <span className={styles.segmentLabel}>{thinkingLabel}</span>
          </span>
        </button>

        <span className={styles.divider} />

        <button
          type="button"
          className={styles.segment}
          onClick={openDropdown}
          disabled={disabled}
          title={reasoningSettingsLabel}
          aria-expanded={dropdownOpen}
        >
          {showThinkingBlocks ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>

        {showEffort && (
          <>
            <span className={styles.divider} />
            <button
              type="button"
              className={styles.segment}
              onClick={openDropdown}
              disabled={disabled}
              title={setEffortLabel}
              aria-expanded={dropdownOpen}
            >
              <span className={styles.effortLabel}>{effortLabel.toLowerCase()}</span>
              <span className={styles.chevron}>
                <ChevronDown size={12} />
              </span>
            </button>
          </>
        )}
      </div>

      {dropdownOpen && (
        <div className={styles.dropdown}>
          <div className={styles.sectionLabel}>{thinkingLabel}</div>
          <button
            type="button"
            className={`${styles.menuItem} ${thinkingEnabled ? styles.menuItemActive : ""}`}
            onClick={toggleThinking}
          >
            <span className={styles.menuIcon}><Brain size={14} /></span>
            <span className={styles.menuLabel}>{thinkingLabel}</span>
            <span className={styles.menuMeta}>{thinkingEnabled ? "on" : "off"}</span>
          </button>
          <button
            type="button"
            className={`${styles.menuItem} ${showThinkingBlocks ? styles.menuItemActive : ""}`}
            onClick={toggleShowThinking}
          >
            <span className={styles.menuIcon}>
              {showThinkingBlocks ? <Eye size={14} /> : <EyeOff size={14} />}
            </span>
            <span className={styles.menuLabel}>{showThinkingLabel}</span>
            <span className={styles.menuMeta}>{showThinkingBlocks ? "on" : "off"}</span>
          </button>

          {showEffort && (
            <>
              <div className={styles.sectionDivider} />
              <div className={styles.sectionLabel}>{effortGroupLabel}</div>
              {levels.map((level) => (
                <button
                  key={level.id}
                  type="button"
                  className={`${styles.menuItem} ${level.id === normalizedEffort ? styles.menuItemActive : ""}`}
                  onClick={() => handleEffortSelect(level.id)}
                >
                  <span
                    className={styles.effortDot}
                    style={{
                      background: level.id === normalizedEffort
                        ? "var(--accent-primary)"
                        : "var(--text-dim)",
                    }}
                  />
                  <span className={styles.menuLabel}>{level.label}</span>
                  {level.id === normalizedEffort && (
                    <span className={styles.menuMeta}>&#x2713;</span>
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
