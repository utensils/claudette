import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleDollarSign, Sparkles, BookOpen } from "lucide-react";
import { useAppStore } from "../../../stores/useAppStore";
import { getAppSetting } from "../../../services/tauri";
import { tooltipAttributes } from "../../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../../hotkeys/platform";
import { ModelSelector, is1mContextModel, get1mFallback } from "../ModelSelector";
import { buildModelRegistry } from "../modelRegistry";
import { isFastSupported, isEffortSupported, isXhighEffortAllowed, isMaxEffortAllowed } from "../modelCapabilities";
import { applySelectedModel } from "../applySelectedModel";
import { applyPlanModeMountDefault } from "../applyPlanModeMountDefault";
import { ToolbarPill } from "./ToolbarPill";
import { ReasoningPill } from "./ReasoningPill";
import { OverflowMenu } from "./OverflowMenu";
import { ClaudeFlagsTooltip } from "./ClaudeFlagsTooltip";
import styles from "./ComposerToolbar.module.css";

interface ComposerToolbarProps {
  sessionId: string;
  workspaceId: string;
  repoId: string | null;
  disabled: boolean;
  isRemote: boolean;
}

export function ComposerToolbar({
  sessionId,
  workspaceId,
  repoId,
  disabled,
  isRemote,
}: ComposerToolbarProps) {
  const selectedModel = useAppStore((s) => s.selectedModel[sessionId] ?? "opus");
  const selectedProvider = useAppStore((s) => s.selectedModelProvider[sessionId] ?? "anthropic");
  const disable1mContext = useAppStore((s) => s.disable1mContext);
  const planMode = useAppStore((s) => s.planMode[sessionId] ?? false);
  const modelSelectorOpen = useAppStore((s) => s.modelSelectorOpen);
  const alternativeBackendsEnabled = useAppStore((s) => s.alternativeBackendsEnabled);
  const agentBackends = useAppStore((s) => s.agentBackends);
  const keybindings = useAppStore((s) => s.keybindings);
  const setSelectedModel = useAppStore((s) => s.setSelectedModel);
  const setFastMode = useAppStore((s) => s.setFastMode);
  const setThinkingEnabled = useAppStore((s) => s.setThinkingEnabled);
  const setPlanMode = useAppStore((s) => s.setPlanMode);
  const setEffortLevel = useAppStore((s) => s.setEffortLevel);
  const setChromeEnabled = useAppStore((s) => s.setChromeEnabled);
  const setShowThinkingBlocks = useAppStore((s) => s.setShowThinkingBlocks);
  const setModelSelectorOpen = useAppStore((s) => s.setModelSelectorOpen);
  const claudeFlagsState = useAppStore(
    (s) => s.claudeFlagsByWorkspace[workspaceId],
  );
  const loadWorkspaceClaudeFlags = useAppStore(
    (s) => s.loadWorkspaceClaudeFlags,
  );

  useEffect(() => {
    if (!claudeFlagsState) {
      void loadWorkspaceClaudeFlags(workspaceId, repoId);
    }
  }, [workspaceId, repoId, claudeFlagsState, loadWorkspaceClaudeFlags]);

  const resolvedFlags = claudeFlagsState?.resolved ?? [];

  const [loaded, setLoaded] = useState(false);

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
      setSelectedModel(sessionId, loadedModel, loadedProvider);
      const effectiveFast = isFastSupported(loadedModel) && (fast === "true" || (!fast && defFast === "true"));
      const effectiveThinking = thinking === "true" || (!thinking && defThinking === "true");
      setFastMode(sessionId, effectiveFast);
      setThinkingEnabled(sessionId, effectiveThinking);
      applyPlanModeMountDefault(sessionId, defPlan === "true");
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
    async (model: string, providerId = "anthropic") => {
      if (model !== selectedModel || providerId !== selectedProvider) {
        await applySelectedModel(sessionId, model, providerId);
      }
      setModelSelectorOpen(false);
    },
    [sessionId, selectedModel, selectedProvider, setModelSelectorOpen],
  );

  const togglePlan = useCallback(() => {
    setPlanMode(sessionId, !planMode);
  }, [sessionId, planMode, setPlanMode]);

  // The Cmd/Ctrl+T thinking-mode hotkey lived here as a raw
  // `window.addEventListener("keydown")` listener. It's been removed —
  // Cmd+T is now the registered `global.new-tab` action (see
  // `useKeyboardShortcuts`), and thinking remains toggleable via the
  // ReasoningPill click + the command palette ("Toggle thinking").

  useEffect(() => {
    if (!loaded || !disable1mContext) return;
    if (is1mContextModel(selectedModel)) {
      void applySelectedModel(sessionId, get1mFallback(selectedModel));
    }
  }, [loaded, disable1mContext, selectedModel, sessionId]);

  const registry = useMemo(
    () => buildModelRegistry(alternativeBackendsEnabled, agentBackends),
    [alternativeBackendsEnabled, agentBackends],
  );
  const currentModel = registry.find(
    (m) => m.id === selectedModel && (m.providerId ?? "anthropic") === selectedProvider,
  );
  const modelLabel = currentModel?.providerLabel
    ? `${currentModel.providerLabel} / ${currentModel.label}`
    : currentModel?.label ?? selectedModel;
  const isExtraUsage = currentModel?.extraUsage ?? false;
  const extraUsageProOnly = currentModel?.extraUsageScope === "pro_only";
  const isMac = isMacHotkeyPlatform();

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
          title={
            isExtraUsage
              ? extraUsageProOnly
                ? "Change model (extra usage on Pro plans: 1M context billed at API rates)"
                : "Change model (extra usage: 1M context billed at API rates)"
              : "Change model"
          }
        >
          {isExtraUsage && <CircleDollarSign size={14} className={styles.extraUsage} />}
        </ToolbarPill>
        {modelSelectorOpen && (
          <ModelSelector
            selected={selectedModel}
            selectedProvider={selectedProvider}
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
        {...tooltipAttributes(
          `${planMode ? "Disable" : "Enable"} plan mode`,
          "global.toggle-plan-mode",
          keybindings,
          isMac,
        )}
        ariaPressed={planMode}
      />

      <ReasoningPill sessionId={sessionId} disabled={disabled} />

      <ClaudeFlagsTooltip resolved={resolvedFlags} />

      <OverflowMenu sessionId={sessionId} disabled={disabled} isRemote={isRemote} />
    </div>
  );
}
