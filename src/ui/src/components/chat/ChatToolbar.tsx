import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Zap, Brain, BookOpen } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { resetAgentSession, setAppSetting, getAppSetting } from "../../services/tauri";
import { ModelSelector, MODELS } from "./ModelSelector";
import styles from "./ChatToolbar.module.css";

interface ChatToolbarProps {
  workspaceId: string;
  disabled: boolean;
}

export function ChatToolbar({ workspaceId, disabled }: ChatToolbarProps) {
  const selectedModel = useAppStore((s) => s.selectedModel[workspaceId] ?? "opus");
  const fastMode = useAppStore((s) => s.fastMode[workspaceId] ?? false);
  const thinkingEnabled = useAppStore((s) => s.thinkingEnabled[workspaceId] ?? false);
  const planMode = useAppStore((s) => s.planMode[workspaceId] ?? false);
  const modelSelectorOpen = useAppStore((s) => s.modelSelectorOpen);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const setModelSelectorOpen = useAppStore((s) => s.setModelSelectorOpen);
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);

  const modelChipRef = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState(false);

  // Load persisted settings on mount / workspace change.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [model, fast, thinking] = await Promise.all([
        getAppSetting(`model:${workspaceId}`),
        getAppSetting(`fast_mode:${workspaceId}`),
        getAppSetting(`thinking_enabled:${workspaceId}`),
      ]);
      if (cancelled) return;
      if (model) setSelectedModel(workspaceId, model);
      if (fast === "true") setFastMode(workspaceId, true);
      if (thinking === "true") setThinkingEnabled(workspaceId, true);
      setLoaded(true);
    }
    load();
    return () => { cancelled = true; };
  }, [workspaceId, setSelectedModel, setFastMode, setThinkingEnabled]);

  const handleModelSelect = useCallback(
    async (model: string) => {
      if (model !== selectedModel) {
        setSelectedModel(workspaceId, model);
        await setAppSetting(`model:${workspaceId}`, model);
        // Model is session-level — reset session so next turn uses the new model.
        await resetAgentSession(workspaceId);
        clearAgentQuestion(workspaceId);
      }
      setModelSelectorOpen(false);
    },
    [workspaceId, selectedModel, setSelectedModel, setModelSelectorOpen, clearAgentQuestion]
  );

  const toggleFast = useCallback(async () => {
    const next = !fastMode;
    setFastMode(workspaceId, next);
    await setAppSetting(`fast_mode:${workspaceId}`, String(next));
  }, [workspaceId, fastMode, setFastMode]);

  const toggleThinking = useCallback(async () => {
    const next = !thinkingEnabled;
    setThinkingEnabled(workspaceId, next);
    await setAppSetting(`thinking_enabled:${workspaceId}`, String(next));
  }, [workspaceId, thinkingEnabled, setThinkingEnabled]);

  const togglePlan = useCallback(() => {
    setPlanMode(workspaceId, !planMode);
  }, [workspaceId, planMode, setPlanMode]);

  // Keyboard shortcuts.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.metaKey && e.key === "t") {
        e.preventDefault();
        if (!disabled) toggleThinking();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [disabled, toggleThinking]);

  const modelLabel =
    MODELS.find((m) => m.id === selectedModel)?.label ?? selectedModel;

  if (!loaded) return null;

  return (
    <div className={styles.toolbar}>
      <button
        ref={modelChipRef}
        className={`${styles.chip}`}
        onClick={() => setModelSelectorOpen(!modelSelectorOpen)}
        disabled={disabled}
        title="Change model"
      >
        <Sparkles size={14} />
        <span className={styles.chipLabel}>{modelLabel}</span>
      </button>

      <button
        className={`${styles.chip} ${fastMode ? styles.chipActive : ""}`}
        onClick={toggleFast}
        disabled={disabled}
        title="Enable fast mode (uses extra credits)"
        aria-pressed={fastMode}
      >
        <Zap size={14} />
      </button>

      <button
        className={`${styles.chip} ${thinkingEnabled ? styles.chipActive : ""}`}
        onClick={toggleThinking}
        disabled={disabled}
        title={`${thinkingEnabled ? "Disable" : "Enable"} thinking`}
        aria-pressed={thinkingEnabled}
      >
        <Brain size={14} />
        <span className={styles.chipLabel}>Thinking</span>
      </button>

      <button
        className={`${styles.chip} ${planMode ? styles.chipActive : ""}`}
        onClick={togglePlan}
        disabled={disabled}
        title={`${planMode ? "Disable" : "Enable"} plan mode`}
        aria-pressed={planMode}
      >
        <BookOpen size={14} />
        <span className={styles.chipLabel}>Plan</span>
      </button>

      {modelSelectorOpen && (
        <ModelSelector
          anchorRef={modelChipRef}
          selected={selectedModel}
          onSelect={handleModelSelect}
          onClose={() => setModelSelectorOpen(false)}
        />
      )}
    </div>
  );
}
