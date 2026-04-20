import { useCallback, useEffect, useState } from "react";
import { CircleDollarSign, Sparkles, Zap, Brain, BookOpen, Gauge, Eye, EyeOff, Globe } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { resetAgentSession, setAppSetting, getAppSetting } from "../../services/tauri";
import { ModelSelector, MODELS } from "./ModelSelector";
import { EffortSelector, EFFORT_LEVELS } from "./EffortSelector";
import { isFastSupported, isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "./modelCapabilities";
import { applySelectedModel } from "./applySelectedModel";
import { applyPlanModeMountDefault } from "./applyPlanModeMountDefault";
import { ContextMeter } from "./ContextMeter";
import styles from "./ChatToolbar.module.css";

interface ChatToolbarProps {
  sessionId: string;
  disabled: boolean;
}

const isMac = typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
const mod = isMac ? "⌘" : "Ctrl+";

export function ChatToolbar({ sessionId, disabled }: ChatToolbarProps) {
  const selectedModel = useAppStore((s) => s.selectedModel[sessionId] ?? "opus");
  const fastMode = useAppStore((s) => s.fastMode[sessionId] ?? false);
  const thinkingEnabled = useAppStore((s) => s.thinkingEnabled[sessionId] ?? false);
  const planMode = useAppStore((s) => s.planMode[sessionId] ?? false);
  const effortLevel = useAppStore((s) => s.effortLevel[sessionId] ?? "auto");
  const chromeEnabled = useAppStore((s) => s.chromeEnabled[sessionId] ?? false);
  const modelSelectorOpen = useAppStore((s) => s.modelSelectorOpen);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const showThinkingBlocks = useAppStore((s) => s.showThinkingBlocks[sessionId] === true);
  const setEffortLevel = useAppStore((s) => s.setEffortLevel);
  const setChromeEnabled = useAppStore((s) => s.setChromeEnabled);
  const setShowThinkingBlocks = useAppStore((s) => s.setShowThinkingBlocks);
  const setModelSelectorOpen = useAppStore((s) => s.setModelSelectorOpen);
  const clearAgentQuestion = useAppStore((s) => s.clearAgentQuestion);
  const clearPlanApproval = useAppStore((s) => s.clearPlanApproval);
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);

  const [loaded, setLoaded] = useState(false);
  const [effortSelectorOpen, setEffortSelectorOpen] = useState(false);

  // Load persisted settings on mount / session change.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [model, fast, thinking, effort, showThinking, chrome, defModel, defFast, defThinking, defPlan, defEffort, defShowThinking, defChrome] = await Promise.all([
        getAppSetting(`model:${sessionId}`),
        getAppSetting(`fast_mode:${sessionId}`),
        getAppSetting(`thinking_enabled:${sessionId}`),
        getAppSetting(`effort_level:${sessionId}`),
        getAppSetting(`show_thinking:${sessionId}`),
        getAppSetting(`chrome_enabled:${sessionId}`),
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
      setSelectedModel(sessionId, loadedModel);
      const effectiveFast = isFastSupported(loadedModel) && (fast === "true" || (!fast && defFast === "true"));
      const effectiveThinking = thinking === "true" || (!thinking && defThinking === "true");
      setFastMode(sessionId, effectiveFast);
      setThinkingEnabled(sessionId, effectiveThinking);
      applyPlanModeMountDefault(sessionId, defPlan === "true");
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
        setEffortLevel(sessionId, normalized);
      }
      setShowThinkingBlocks(sessionId, showThinking === "true" || (!showThinking && defShowThinking === "true"));
      setChromeEnabled(sessionId, chrome === "true" || (!chrome && defChrome === "true"));
      setLoaded(true);
    }
    load();
    return () => { cancelled = true; };
  }, [sessionId, setSelectedModel, setFastMode, setThinkingEnabled, setEffortLevel, setShowThinkingBlocks, setChromeEnabled]);

  const handleModelSelect = useCallback(
    async (model: string) => {
      if (model !== selectedModel) {
        await applySelectedModel(sessionId, model);
      }
      setModelSelectorOpen(false);
    },
    [sessionId, selectedModel, setModelSelectorOpen],
  );

  const handleEffortSelect = useCallback(
    async (level: string) => {
      setEffortLevel(sessionId, level);
      await setAppSetting(`effort_level:${sessionId}`, level);
      setEffortSelectorOpen(false);
    },
    [sessionId, setEffortLevel],
  );

  const toggleFast = useCallback(async () => {
    const next = !fastMode;
    setFastMode(sessionId, next);
    await setAppSetting(`fast_mode:${sessionId}`, String(next));
  }, [sessionId, fastMode, setFastMode]);

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

  const togglePlan = useCallback(() => {
    setPlanMode(sessionId, !planMode);
  }, [sessionId, planMode, setPlanMode]);

  const toggleChrome = useCallback(async () => {
    const next = !chromeEnabled;
    setChromeEnabled(sessionId, next);
    await setAppSetting(`chrome_enabled:${sessionId}`, String(next));
    // Chrome is session-level — reset session so the next turn picks up the change.
    await resetAgentSession(sessionId);
    clearAgentQuestion(sessionId);
    clearPlanApproval(sessionId);
  }, [sessionId, chromeEnabled, setChromeEnabled, clearAgentQuestion, clearPlanApproval]);

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
        className={`${styles.chip}`}
        onClick={() => setModelSelectorOpen(!modelSelectorOpen)}
        disabled={disabled}
        title={isExtraUsage ? "Change model (extra usage: 1M context billed at API rates)" : "Change model"}
      >
        <Sparkles size={14} />
        <span className={styles.chipLabel}>{modelLabel}</span>
        {isExtraUsage && <CircleDollarSign size={14} className={styles.extraUsage} />}
      </button>

      <ContextMeter workspaceId={workspaceId} />

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
