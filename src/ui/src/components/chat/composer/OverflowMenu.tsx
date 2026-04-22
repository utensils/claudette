import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Zap, Globe } from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import { resetAgentSession, setAppSetting } from "../../../services/tauri";
import { isFastSupported } from "../modelCapabilities";
import styles from "./OverflowMenu.module.css";

interface OverflowMenuProps {
  workspaceId: string;
  disabled: boolean;
}

export function OverflowMenu({ workspaceId, disabled }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedModel = useAppStore((s) => s.selectedModel[workspaceId] ?? "opus");
  const fastMode = useAppStore((s) => s.fastMode[workspaceId] ?? false);
  const chromeEnabled = useAppStore((s) => s.chromeEnabled[workspaceId] ?? false);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const setChromeEnabled = useAppStore((s) => s.setChromeEnabled);
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);

  const showFast = isFastSupported(selectedModel);
  const anyActive = fastMode || chromeEnabled;

  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const toggleFast = useCallback(async () => {
    const next = !fastMode;
    setFastMode(workspaceId, next);
    await setAppSetting(`fast_mode:${workspaceId}`, String(next));
  }, [workspaceId, fastMode, setFastMode]);

  const toggleChrome = useCallback(async () => {
    const next = !chromeEnabled;
    setChromeEnabled(workspaceId, next);
    await setAppSetting(`chrome_enabled:${workspaceId}`, String(next));
    await resetAgentSession(workspaceId);
    clearAgentQuestion(workspaceId);
    clearPlanApproval(workspaceId);
  }, [workspaceId, chromeEnabled, setChromeEnabled, clearAgentQuestion, clearPlanApproval]);

  return (
    <div ref={containerRef} className={styles.wrap}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="More options"
        aria-expanded={open}
      >
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
        {anyActive && <span className={styles.badge} />}
      </button>

      {open && (
        <div className={styles.dropdown}>
          {showFast && (
            <MenuItem
              icon={<Zap size={14} />}
              label="Fast mode"
              active={fastMode}
              meta={fastMode ? "on" : "off"}
              onClick={toggleFast}
            />
          )}
          <MenuItem
            icon={<Globe size={14} />}
            label="Claude in Chrome"
            active={chromeEnabled}
            meta={chromeEnabled ? "on" : "off"}
            onClick={toggleChrome}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  active,
  meta,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.item} ${active ? styles.itemActive : ""}`}
      onClick={onClick}
    >
      <span className={styles.itemIcon}>{icon}</span>
      <span className={styles.itemLabel}>{label}</span>
      <span className={styles.itemMeta}>{meta}</span>
    </button>
  );
}
