import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeDollarSign, Sparkles, Zap, Brain, BookOpen, Gauge, Eye, EyeOff, Globe } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { resetAgentSession, setAppSetting, getAppSetting } from "../../services/tauri";
import { ModelSelector, MODELS } from "./ModelSelector";
import { EffortSelector, EFFORT_LEVELS } from "./EffortSelector";
import { isFastSupported, isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "./modelCapabilities";
import styles from "./ChatToolbar.module.css";

interface ChatToolbarProps {
  workspaceId: string;
  disabled: boolean;
}

const isMac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
const mod = isMac ? "⌘" : "Ctrl+";

export function ChatToolbar({ workspaceId, disabled }: ChatToolbarProps) {
  const selectedModel = useAppStore((s) => s.selectedModel[workspaceId] ?? "opus");
  const fastMode = useAppStore((s) => s.fastMode[workspaceId] ?? false);
  const thinkingEnabled = useAppStore((s) => s.thinkingEnabled[workspaceId] ?? false);
  const planMode = useAppStore((s) => s.planMode[workspaceId] ?? false);
  const effortLevel = useAppStore((s) => s.effortLevel[workspaceId] ?? "auto");
  const chromeEnabled = useAppStore((s) => s.chromeEnabled[workspaceId] ?? false);
  const modelSelectorOpen = useAppStore((s) => s.modelSelectorOpen);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const showThinkingBlocks = useAppStore((s) => s.showThinkingBlocks[workspaceId] === true);
  const setEffortLevel = useAppStore((s) => s.setEffortLevel);
  const setChromeEnabled = useAppStore((s) => s.setChromeEnabled);
  const setShowThinkingBlocks = useAppStore((s) => s.setShowThinkingBlocks);
  const setModelSelectorOpen = useAppStore((s) => s.setModelSelectorOpen);
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);

  const modelChipRef = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [effortSelectorOpen, setEffortSelectorOpen] = useState(false);

  // Load persisted settings on mount / workspace change.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [model, fast, thinking, effort, showThinking, chrome, defModel, defFast, defThinking, defPlan, defEffort, defShowThinking, defChrome] = await Promise.all([
        getAppSetting(`model:${workspaceId}`),
        getAppSetting(`fast_mode:${workspaceId}`),
        getAppSetting(`thinking_enabled:${workspaceId}`),
        getAppSetting(`effort_level:${workspaceId}`),
        getAppSetting(`show_thinking:${workspaceId}`),
        getAppSetting(`chrome_enabled:${workspaceId}`),
        getAppSetting("default_model"),
        getAppSetting("default_fast_mode"),
        getAppSetting("default_thinking"),
        getAppSetting("default_plan_mode"),
        getAppSetting("default_effort"),
        getAppSetting("default_show_thinking"),
        getAppSetting("default_chrome"),
      ]);
      if (cancelled) return;
      const loadedModel = model ?? defModel ?? "opus";
      setSelectedModel(workspaceId, loadedModel);
      const effectiveFast = isFastSupported(loadedModel) && (fast === "true" || (!fast && defFast === "true"));
      const effectiveThinking = thinking === "true" || (!thinking && defThinking === "true");
      setFastMode(workspaceId, effectiveFast);
      setThinkingEnabled(workspaceId, effectiveThinking);
      // Plan mode is not persisted per-workspace (in-memory only); apply global
      // default only when fast/thinking aren't already enabled.
      setPlanMode(workspaceId, !effectiveFast && !effectiveThinking && defPlan === "true");
      // Normalize effort against the loaded model to prevent stale values.
      const effectiveEffort = effort ?? defEffort;
      if (effectiveEffort) {
        const normalized = !isEffortSupported(loadedModel)
          ? "auto"
          : effectiveEffort === "xhigh" && !isXhighEffortAllowed(loadedModel)
            ? "high"
            : effectiveEffort === "max" && !isMaxEffortAllowed(loadedModel)
              ? "high"
              : effectiveEffort;
        setEffortLevel(workspaceId, normalized);
      }
      setShowThinkingBlocks(workspaceId, showThinking === "true" || (!showThinking && defShowThinking === "true"));
      setChromeEnabled(workspaceId, chrome === "true" || (!chrome && defChrome === "true"));
      setLoaded(true);
    }
    load();
    return () => { cancelled = true; };
  }, [workspaceId, setSelectedModel, setFastMode, setThinkingEnabled, setPlanMode, setEffortLevel, setShowThinkingBlocks, setChromeEnabled]);

  const handleModelSelect = useCallback(
    async (model: string) => {
      if (model !== selectedModel) {
        setSelectedModel(workspaceId, model);
        await setAppSetting(`model:${workspaceId}`, model);
        // Model is session-level — reset session so next turn uses the new model.
        await resetAgentSession(workspaceId);
        clearAgentQuestion(workspaceId);
        clearPlanApproval(workspaceId);
        // Turn off fast mode if the new model doesn't support it.
        if (fastMode && !isFastSupported(model)) {
          setFastMode(workspaceId, false);
          await setAppSetting(`fast_mode:${workspaceId}`, "false");
        }
        // Reset effort when switching to a model with different support.
        if (!isEffortSupported(model)) {
          // Model doesn't support effort at all — clear to auto (won't be sent).
          setEffortLevel(workspaceId, "auto");
          await setAppSetting(`effort_level:${workspaceId}`, "auto");
        } else if (effortLevel === "xhigh" && !isXhighEffortAllowed(model)) {
          // Model supports effort but not "xhigh" — fall back to high.
          setEffortLevel(workspaceId, "high");
          await setAppSetting(`effort_level:${workspaceId}`, "high");
        } else if (effortLevel === "max" && !isMaxEffortAllowed(model)) {
          // Model supports effort but not "max" — fall back to high.
          setEffortLevel(workspaceId, "high");
          await setAppSetting(`effort_level:${workspaceId}`, "high");
        }
      }
      setModelSelectorOpen(false);
    },
    [workspaceId, selectedModel, fastMode, effortLevel, setSelectedModel, setFastMode, setEffortLevel, setModelSelectorOpen, clearAgentQuestion, clearPlanApproval]
  );

  const handleEffortSelect = useCallback(
    async (level: string) => {
      setEffortLevel(workspaceId, level);
      await setAppSetting(`effort_level:${workspaceId}`, level);
      setEffortSelectorOpen(false);
    },
    [workspaceId, setEffortLevel],
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

  const toggleShowThinking = useCallback(async () => {
    const next = !showThinkingBlocks;
    setShowThinkingBlocks(workspaceId, next);
    await setAppSetting(`show_thinking:${workspaceId}`, String(next));
  }, [workspaceId, showThinkingBlocks, setShowThinkingBlocks]);

  const togglePlan = useCallback(() => {
    setPlanMode(workspaceId, !planMode);
  }, [workspaceId, planMode, setPlanMode]);

  const toggleChrome = useCallback(async () => {
    const next = !chromeEnabled;
    setChromeEnabled(workspaceId, next);
    await setAppSetting(`chrome_enabled:${workspaceId}`, String(next));
    // Chrome is session-level — reset session so the next turn picks up the change.
    await resetAgentSession(workspaceId);
    clearAgentQuestion(workspaceId);
    clearPlanApproval(workspaceId);
  }, [workspaceId, chromeEnabled, setChromeEnabled, clearAgentQuestion, clearPlanApproval]);

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

  const currentModel = MODELS.find((m) => m.id === selectedModel);
  const modelLabel = currentModel?.label ?? selectedModel;
  const isExtraUsage = currentModel?.extraUsage ?? false;
  const effortLabel =
    EFFORT_LEVELS.find((l) => l.id === effortLevel)?.label ?? effortLevel;

  if (!loaded) return null;

  return (
    <div className={styles.toolbar}>
      <button
        ref={modelChipRef}
        className={`${styles.chip}`}
        onClick={() => setModelSelectorOpen(!modelSelectorOpen)}
        disabled={disabled}
        title={isExtraUsage ? "Change model (extra usage: 1M context billed at API rates)" : "Change model"}
      >
        <Sparkles size={14} />
        <span className={styles.chipLabel}>{modelLabel}</span>
        {isExtraUsage && <BadgeDollarSign size={14} className={styles.extraUsage} />}
      </button>

      {isFastSupported(selectedModel) && (
        <button
          className={`${styles.chip} ${fastMode ? styles.chipActive : ""}`}
          onClick={toggleFast}
          disabled={disabled}
          title={`${fastMode ? "Disable" : "Enable"} fast mode (faster output, same model)`}
          aria-pressed={fastMode}
        >
          <Zap size={14} />
        </button>
      )}

      <button
        className={`${styles.chip} ${thinkingEnabled ? styles.chipActive : ""}`}
        onClick={toggleThinking}
        disabled={disabled}
        title={`${thinkingEnabled ? "Disable" : "Enable"} extended thinking (forces reasoning on every turn)`}
        aria-pressed={thinkingEnabled}
      >
        <Brain size={14} />
        <span className={styles.chipLabel}>Thinking</span>
        <kbd className={`shortcut-badge ${metaKeyHeld ? "shortcut-badge-visible" : ""}`} aria-hidden="true">{mod}T</kbd>
      </button>

      <button
        className={`${styles.chip} ${showThinkingBlocks ? styles.chipActive : ""}`}
        onClick={toggleShowThinking}
        title={`${showThinkingBlocks ? "Hide" : "Show"} thinking traces in chat`}
        aria-pressed={showThinkingBlocks}
      >
        {showThinkingBlocks ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>

      {isEffortSupported(selectedModel) && (
        <button
          className={styles.chip}
          onClick={() => setEffortSelectorOpen(!effortSelectorOpen)}
          disabled={disabled}
          title="Set effort level"
        >
          <Gauge size={14} />
          <span className={styles.chipLabel}>{effortLabel}</span>
        </button>
      )}

      <button
        className={`${styles.chip} ${planMode ? styles.chipActive : ""}`}
        onClick={togglePlan}
        disabled={disabled}
        title={`${planMode ? "Disable" : "Enable"} plan mode`}
        aria-pressed={planMode}
      >
        <BookOpen size={14} />
        <span className={styles.chipLabel}>Plan</span>
        <kbd className={`shortcut-badge ${metaKeyHeld ? "shortcut-badge-visible" : ""}`} aria-hidden="true">⇧Tab</kbd>
      </button>

      <button
        className={`${styles.chip} ${chromeEnabled ? styles.chipActive : ""}`}
        onClick={toggleChrome}
        disabled={disabled}
        title={`${chromeEnabled ? "Disable" : "Enable"} Chrome browser mode`}
        aria-pressed={chromeEnabled}
      >
        <Globe size={14} />
        <span className={styles.chipLabel}>Chrome</span>
      </button>

      {modelSelectorOpen && (
        <ModelSelector
          anchorRef={modelChipRef}
          selected={selectedModel}
          onSelect={handleModelSelect}
          onClose={() => setModelSelectorOpen(false)}
        />
      )}

      {effortSelectorOpen && isEffortSupported(selectedModel) && (
        <EffortSelector
          selected={effortLevel}
          selectedModel={selectedModel}
          onSelect={handleEffortSelect}
          onClose={() => setEffortSelectorOpen(false)}
        />
      )}
    </div>
  );
}
