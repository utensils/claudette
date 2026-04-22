import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, Eye, EyeOff, ChevronDown } from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import { setAppSetting } from "../../../services/tauri";
import { isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "../modelCapabilities";
import { EFFORT_LEVELS } from "../EffortSelector";
import styles from "./ReasoningPill.module.css";

interface ReasoningPillProps {
  workspaceId: string;
  disabled: boolean;
}

function getAvailableLevels(model: string) {
  if (isXhighEffortAllowed(model)) return EFFORT_LEVELS;
  if (isMaxEffortAllowed(model)) return EFFORT_LEVELS.filter((l) => l.id !== "xhigh");
  return EFFORT_LEVELS.filter((l) => l.id !== "xhigh" && l.id !== "max");
}

export function ReasoningPill({ workspaceId, disabled }: ReasoningPillProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedModel = useAppStore((s) => s.selectedModel[workspaceId] ?? "opus");
  const thinkingEnabled = useAppStore((s) => s.thinkingEnabled[workspaceId] ?? false);
  const showThinkingBlocks = useAppStore((s) => s.showThinkingBlocks[workspaceId] === true);
  const effortLevel = useAppStore((s) => s.effortLevel[workspaceId] ?? "auto");
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setShowThinkingBlocks = useAppStore((s) => s.setShowThinkingBlocks);
  const setEffortLevel = useAppStore((s) => s.setEffortLevel);
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);

  const isMac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
  const mod = isMac ? "⌘" : "Ctrl+";

  const showEffort = isEffortSupported(selectedModel);
  const effortLabel = EFFORT_LEVELS.find((l) => l.id === effortLevel)?.label ?? effortLevel;
  const isActive = thinkingEnabled;

  const openDropdown = useCallback(() => {
    if (!disabled) setDropdownOpen(true);
  }, [disabled]);

  const toggleThinking = useCallback(async () => {
    const next = !thinkingEnabled;
    setThinkingEnabled(workspaceId, next);
    await setAppSetting(`thinking_enabled:${workspaceId}`, String(next));
  }, [workspaceId, thinkingEnabled, setThinkingEnabled]);

  const toggleShowThinking = useCallback(async () => {
    const next = !showThinkingBlocks;
    setShowThinkingBlocks(workspaceId, next);
    await setAppSetting(`show_thinking:${workspaceId}`, String(next));
  }, [workspaceId, showThinkingBlocks, setShowThinkingBlocks]);

  const handleEffortSelect = useCallback(
    async (level: string) => {
      setEffortLevel(workspaceId, level);
      await setAppSetting(`effort_level:${workspaceId}`, level);
      setDropdownOpen(false);
    },
    [workspaceId, setEffortLevel],
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

  const levels = getAvailableLevels(selectedModel);

  return (
    <div ref={containerRef} className={styles.wrap}>
      <div className={`${styles.pill} ${isActive ? styles.pillActive : ""}`}>
        <button
          type="button"
          className={styles.segment}
          onClick={openDropdown}
          disabled={disabled}
          title={`${thinkingEnabled ? "Disable" : "Enable"} extended thinking`}
          aria-expanded={dropdownOpen}
        >
          <Brain size={14} />
          <span className={styles.segmentLabel}>Thinking</span>
          {metaKeyHeld && (
            <kbd className={styles.shortcutBadge} aria-hidden="true">{mod}T</kbd>
          )}
        </button>

        <span className={styles.divider} />

        <button
          type="button"
          className={styles.segment}
          onClick={openDropdown}
          disabled={disabled}
          title={`${showThinkingBlocks ? "Hide" : "Show"} thinking traces`}
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
              title="Set effort level"
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
          <div className={styles.sectionLabel}>Reasoning</div>
          <button
            type="button"
            className={`${styles.menuItem} ${thinkingEnabled ? styles.menuItemActive : ""}`}
            onClick={toggleThinking}
          >
            <span className={styles.menuIcon}><Brain size={14} /></span>
            <span className={styles.menuLabel}>Thinking</span>
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
            <span className={styles.menuLabel}>Show thinking</span>
            <span className={styles.menuMeta}>{showThinkingBlocks ? "on" : "off"}</span>
          </button>

          {showEffort && (
            <>
              <div className={styles.sectionDivider} />
              <div className={styles.sectionLabel}>Effort</div>
              {levels.map((level) => (
                <button
                  key={level.id}
                  type="button"
                  className={`${styles.menuItem} ${level.id === effortLevel ? styles.menuItemActive : ""}`}
                  onClick={() => handleEffortSelect(level.id)}
                >
                  <span
                    className={styles.effortDot}
                    style={{
                      background: level.id === effortLevel
                        ? "var(--accent-primary)"
                        : "var(--text-dim)",
                    }}
                  />
                  <span className={styles.menuLabel}>{level.label}</span>
                  {level.id === effortLevel && (
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
