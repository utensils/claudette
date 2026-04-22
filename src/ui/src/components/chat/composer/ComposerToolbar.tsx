import { useCallback, useEffect, useState } from "react";
import { BadgeDollarSign, Sparkles, BookOpen } from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import { getAppSetting, setAppSetting } from "../../../services/tauri";
import { ModelSelector, MODELS } from "../ModelSelector";
import { isFastSupported, isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "../modelCapabilities";
import { applySelectedModel } from "../applySelectedModel";
import { applyPlanModeMountDefault } from "../applyPlanModeMountDefault";
import { ToolbarPill } from "./ToolbarPill";
import { ReasoningPill } from "./ReasoningPill";
import { OverflowMenu } from "./OverflowMenu";
import styles from "./ComposerToolbar.module.css";

interface ComposerToolbarProps {
  workspaceId: string;
  disabled: boolean;
}

export function ComposerToolbar({ workspaceId, disabled }: ComposerToolbarProps) {
  const selectedModel = useAppStore((s) => s.selectedModel[workspaceId] ?? "opus");
  const thinkingEnabled = useAppStore((s) => s.thinkingEnabled[workspaceId] ?? false);
  const planMode = useAppStore((s) => s.planMode[workspaceId] ?? false);
  const modelSelectorOpen = useAppStore((s) => s.modelSelectorOpen);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const setEffortLevel = useAppStore((s) => s.setEffortLevel);
  const setChromeEnabled = useAppStore((s) => s.setChromeEnabled);
  const setShowThinkingBlocks = useAppStore((s) => s.setShowThinkingBlocks);
  const setModelSelectorOpen = useAppStore((s) => s.setModelSelectorOpen);

  const [loaded, setLoaded] = useState(false);

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
      applyPlanModeMountDefault(workspaceId, defPlan === "true");
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
  }, [workspaceId, setSelectedModel, setFastMode, setThinkingEnabled, setEffortLevel, setShowThinkingBlocks, setChromeEnabled]);

  const handleModelSelect = useCallback(
    async (model: string) => {
      if (model !== selectedModel) {
        await applySelectedModel(workspaceId, model);
      }
      setModelSelectorOpen(false);
    },
    [workspaceId, selectedModel, setModelSelectorOpen],
  );

  const toggleThinking = useCallback(async () => {
    const next = !thinkingEnabled;
    setThinkingEnabled(workspaceId, next);
    await setAppSetting(`thinking_enabled:${workspaceId}`, String(next));
  }, [workspaceId, thinkingEnabled, setThinkingEnabled]);

  const togglePlan = useCallback(() => {
    setPlanMode(workspaceId, !planMode);
  }, [workspaceId, planMode, setPlanMode]);

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

  if (!loaded) return null;

  return (
    <div className={styles.toolbar}>
      <div className={styles.modelPillWrap}>
        <ToolbarPill
          icon={<Sparkles size={14} className={styles.accentIcon} />}
          label={modelLabel}
          chevron
          onClick={() => setModelSelectorOpen(!modelSelectorOpen)}
          disabled={disabled}
          title={isExtraUsage ? "Change model (extra usage: 1M context billed at API rates)" : "Change model"}
        >
          {isExtraUsage && <BadgeDollarSign size={14} className={styles.extraUsage} />}
        </ToolbarPill>
        {modelSelectorOpen && (
          <ModelSelector
            selected={selectedModel}
            onSelect={handleModelSelect}
            onClose={() => setModelSelectorOpen(false)}
          />
        )}
      </div>

      <ToolbarPill
        icon={<BookOpen size={14} />}
        label="Plan"
        active={planMode}
        onClick={togglePlan}
        disabled={disabled}
        title={`${planMode ? "Disable" : "Enable"} plan mode`}
        ariaPressed={planMode}
      />

      <ReasoningPill workspaceId={workspaceId} disabled={disabled} />

      <OverflowMenu workspaceId={workspaceId} disabled={disabled} />
    </div>
  );
}
