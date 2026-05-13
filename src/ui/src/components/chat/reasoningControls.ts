import {
  isMaxEffortAllowed,
  isXhighEffortAllowed,
} from "./modelCapabilities";

export type ReasoningControlVariant = "claude" | "codex";

export type ReasoningLevel = {
  id: string;
  label: string;
};

export type ReasoningModelLike = {
  providerId?: string;
  providerKind?: string;
};

export const CLAUDE_EFFORT_LEVELS: readonly ReasoningLevel[] = [
  { id: "auto", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;

export const CODEX_REASONING_LEVELS: readonly ReasoningLevel[] = [
  { id: "auto", label: "Default" },
  { id: "none", label: "None" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
] as const;

export function reasoningVariantForModel(
  model: ReasoningModelLike | undefined,
): ReasoningControlVariant {
  return model?.providerKind === "codex_native" ||
    model?.providerId === "experimental-codex"
    ? "codex"
    : "claude";
}

export function getReasoningLevels(
  model: string,
  variant: ReasoningControlVariant,
): readonly ReasoningLevel[] {
  if (variant === "codex") return CODEX_REASONING_LEVELS;
  if (isXhighEffortAllowed(model)) return CLAUDE_EFFORT_LEVELS;
  if (isMaxEffortAllowed(model)) {
    return CLAUDE_EFFORT_LEVELS.filter((level) => level.id !== "xhigh");
  }
  return CLAUDE_EFFORT_LEVELS.filter(
    (level) => level.id !== "xhigh" && level.id !== "max",
  );
}

export function normalizeReasoningLevel(
  level: string | null | undefined,
  model: string,
  variant: ReasoningControlVariant,
): string {
  const value = level?.trim() || "auto";
  if (getReasoningLevels(model, variant).some((candidate) => candidate.id === value)) {
    return value;
  }
  if (value === "max") return "high";
  if (value === "xhigh") return "high";
  return "auto";
}

export function reasoningLevelLabel(
  level: string,
  model: string,
  variant: ReasoningControlVariant,
): string {
  return (
    getReasoningLevels(model, variant).find((candidate) => candidate.id === level)
      ?.label ?? level
  );
}
