import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleDollarSign, Sparkles, Zap, Brain, BookOpen, Gauge, Eye, EyeOff, Globe } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { resetAgentSession, setAppSetting, getAppSetting } from "../../services/tauri";
import { ModelSelector } from "./ModelSelector";
import { EffortSelector } from "./EffortSelector";
import { isFastSupported, isEffortSupported } from "./modelCapabilities";
import {
  normalizeReasoningLevel,
  reasoningLevelLabel,
  reasoningVariantForModel,
} from "./reasoningControls";
import { buildModelRegistry, findModelInRegistry } from "./modelRegistry";
import { applySelectedModel } from "./applySelectedModel";
import { applyPlanModeMountDefault } from "./applyPlanModeMountDefault";
import { ContextMeter } from "./ContextMeter";
import { useSelectedModelEntry } from "./useSelectedModelEntry";
import { getHotkeyLabel, tooltipAttributes } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import styles from "./ChatToolbar.module.css";

interface ChatToolbarProps {
  sessionId: string;
  disabled: boolean;
}

export function ChatToolbar({ sessionId, disabled }: ChatToolbarProps) {
  const selectedModel = useAppStore((s) => s.selectedModel[sessionId] ?? "opus");
  const selectedProvider = useAppStore((s) => s.selectedModelProvider[sessionId] ?? "anthropic");
  const fastMode = useAppStore((s) => s.fastMode[sessionId] ?? false);
  const thinkingEnabled = useAppStore((s) => s.thinkingEnabled[sessionId] ?? false);
  const planMode = useAppStore((s) => s.planMode[sessionId] ?? false);
  const effortLevel = useAppStore((s) => s.effortLevel[sessionId] ?? "auto");
  const chromeEnabled = useAppStore((s) => s.chromeEnabled[sessionId] ?? false);
  const modelSelectorOpen = useAppStore((s) => s.modelSelectorOpen);
  const alternativeBackendsEnabled = useAppStore((s) => s.alternativeBackendsEnabled);
  const codexEnabled = useAppStore((s) => s.codexEnabled);
  const agentBackends = useAppStore((s) => s.agentBackends);
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
  const clearAgentApproval = useAppStore((s) => s.clearAgentApproval);
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);
  const keybindings = useAppStore((s) => s.keybindings);
  const { t } = useTranslation("chat");

  const [loaded, setLoaded] = useState(false);
  const [effortSelectorOpen, setEffortSelectorOpen] = useState(false);
  const registry = useMemo(
    () => buildModelRegistry(alternativeBackendsEnabled, agentBackends, codexEnabled),
    [alternativeBackendsEnabled, agentBackends, codexEnabled],
  );
  const registryRef = useRef(registry);
  useEffect(() => {
    registryRef.current = registry;
  }, [registry]);

  // Load persisted settings on mount / session change.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [model, provider, fast, thinking, effort, showThinking, chrome, defModel, defProvider, defFast, defThinking, defPlan, defEffort, defShowThinking, defChrome] = await Promise.all([
        getAppSetting(`model:${sessionId}`),
        getAppSetting(`model_provider:${sessionId}`),
        getAppSetting(`fast_mode:${sessionId}`),
        getAppSetting(`thinking_enabled:${sessionId}`),
        getAppSetting(`effort_level:${sessionId}`),
        getAppSetting(`show_thinking:${sessionId}`),
        getAppSetting(`chrome_enabled:${sessionId}`),
        getAppSetting("default_model"),
        getAppSetting("default_agent_backend"),
        getAppSetting("default_fast_mode"),
        getAppSetting("default_thinking"),
        getAppSetting("default_plan_mode"),
        getAppSetting("default_effort"),
        getAppSetting("default_show_thinking"),
        getAppSetting("default_chrome"),
      ]);
      if (cancelled) return;
      const loadedModel = model ?? defModel ?? "opus";
      const loadedProvider = provider ?? defProvider ?? "anthropic";
      const loadedEntry = findModelInRegistry(registryRef.current, loadedModel, loadedProvider);
      const supportsFast = loadedEntry?.supportsFastMode ?? isFastSupported(loadedModel);
      const supportsEffort = loadedEntry?.supportsEffort ?? isEffortSupported(loadedModel);
      setSelectedModel(sessionId, loadedModel, loadedProvider);
      const effectiveFast = supportsFast && (fast === "true" || (!fast && defFast === "true"));
      const effectiveThinking = thinking === "true" || (!thinking && defThinking === "true");
      setFastMode(sessionId, effectiveFast);
      setThinkingEnabled(sessionId, effectiveThinking);
      applyPlanModeMountDefault(sessionId, defPlan === "true");
      // Normalize effort against the loaded model to prevent stale values.
      const effectiveEffort = effort ?? defEffort;
      if (effectiveEffort) {
        const normalized = !supportsEffort
          ? "auto"
          : normalizeReasoningLevel(
              effectiveEffort,
              loadedModel,
              reasoningVariantForModel(loadedEntry),
            );
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
    async (model: string, providerId = "anthropic") => {
      if (model !== selectedModel || providerId !== selectedProvider) {
        await applySelectedModel(sessionId, model, providerId);
      }
      setModelSelectorOpen(false);
    },
    [sessionId, selectedModel, selectedProvider, setModelSelectorOpen],
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
    clearAgentApproval(sessionId);
  }, [sessionId, chromeEnabled, setChromeEnabled, clearAgentQuestion, clearPlanApproval, clearAgentApproval]);

  // The Cmd/Ctrl+T thinking-mode hotkey lived here as a raw
  // `window.addEventListener("keydown")` listener. It's been removed —
  // Cmd+T is now the registered `global.new-tab` action (see
  // `useKeyboardShortcuts`), and Claude thinking remains toggleable via
  // the chip click + the command palette ("Toggle thinking").

  const currentModel = useSelectedModelEntry(sessionId);
  const supportsFast = currentModel?.supportsFastMode ?? isFastSupported(selectedModel);
  const supportsEffort = currentModel?.supportsEffort ?? isEffortSupported(selectedModel);
  const reasoningVariant = reasoningVariantForModel(currentModel);
  const isCodex = reasoningVariant === "codex";
  const modelLabel = currentModel?.providerLabel
    ? `${currentModel.providerLabel} / ${currentModel.label}`
    : currentModel?.label ?? selectedModel;
  const isExtraUsage = currentModel?.extraUsage ?? false;
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
  const isMac = isMacHotkeyPlatform();
  const planShortcut = getHotkeyLabel("global.toggle-plan-mode", keybindings, isMac);

  if (!loaded) return null;

  return (
    <div className={styles.toolbar}>
      <button
        className={`${styles.chip}`}
        onClick={() => setModelSelectorOpen(!modelSelectorOpen)}
        disabled={disabled}
        title={isExtraUsage ? t("change_model_extra_usage") : t("change_model")}
      >
        <Sparkles size={14} />
        <span className={styles.chipLabel}>{modelLabel}</span>
        {isExtraUsage && <CircleDollarSign size={14} className={styles.extraUsage} />}
      </button>

      <ContextMeter sessionId={sessionId} />

      {supportsFast && (
        <button
          className={`${styles.chip} ${fastMode ? styles.chipActive : ""}`}
          onClick={toggleFast}
          disabled={disabled}
          title={fastMode ? t("fast_mode_disable") : t("fast_mode_enable")}
          aria-pressed={fastMode}
        >
          <Zap size={14} />
        </button>
      )}

      {!isCodex && (
        <button
          className={`${styles.chip} ${thinkingEnabled ? styles.chipActive : ""}`}
          onClick={toggleThinking}
          disabled={disabled}
          title={thinkingEnabled ? t("thinking_disable") : t("thinking_enable")}
          aria-pressed={thinkingEnabled}
        >
          <Brain size={14} />
          <span className={styles.chipLabel}>{t("thinking_chip")}</span>
        </button>
      )}

      <button
        className={`${styles.chip} ${showThinkingBlocks ? styles.chipActive : ""}`}
        onClick={toggleShowThinking}
        title={showThinkingBlocks
          ? isCodex ? t("codex_hide_reasoning") : t("hide_thinking")
          : isCodex ? t("codex_show_reasoning") : t("show_thinking")}
        aria-pressed={showThinkingBlocks}
      >
        {showThinkingBlocks ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>

      {supportsEffort && (
        <button
          className={styles.chip}
          onClick={() => setEffortSelectorOpen(!effortSelectorOpen)}
          disabled={disabled}
          title={isCodex ? t("codex_set_reasoning_effort") : t("set_effort")}
        >
          <Gauge size={14} />
          <span className={styles.chipLabel}>{effortLabel}</span>
        </button>
      )}

      <button
        className={`${styles.chip} ${planMode ? styles.chipActive : ""}`}
        onClick={togglePlan}
        disabled={disabled}
        {...tooltipAttributes(
          planMode ? t("plan_mode_disable") : t("plan_mode_enable"),
          "global.toggle-plan-mode",
          keybindings,
          isMac,
        )}
        aria-pressed={planMode}
      >
        <BookOpen size={14} />
        <span className={styles.chipLabel}>{t("plan_chip")}</span>
        {planShortcut && (
          <kbd className={`shortcut-badge ${metaKeyHeld ? "shortcut-badge-visible" : ""}`} aria-hidden="true">{planShortcut}</kbd>
        )}
      </button>

      <button
        className={`${styles.chip} ${chromeEnabled ? styles.chipActive : ""}`}
        onClick={toggleChrome}
        disabled={disabled}
        title={chromeEnabled ? t("chrome_mode_disable") : t("chrome_mode_enable")}
        aria-pressed={chromeEnabled}
      >
        <Globe size={14} />
        <span className={styles.chipLabel}>{t("chrome_chip")}</span>
      </button>

      {modelSelectorOpen && (
        <ModelSelector
          selected={selectedModel}
          selectedProvider={selectedProvider}
          onSelect={handleModelSelect}
          onClose={() => setModelSelectorOpen(false)}
        />
      )}

      {effortSelectorOpen && supportsEffort && (
        <EffortSelector
          selected={normalizedEffort}
          selectedModel={selectedModel}
          variant={reasoningVariant}
          label={isCodex ? t("codex_reasoning_effort") : t("effort")}
          onSelect={handleEffortSelect}
          onClose={() => setEffortSelectorOpen(false)}
        />
      )}
    </div>
  );
}
