/**
 * Model registry — the canonical list of models the UI exposes.
 *
 * Lives in a non-React module so logic that only needs the metadata
 * (slash command validation, toolbar state normalization) can import it
 * without dragging in component CSS or React deps.
 */
export type Model = {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly extraUsage: boolean;
  readonly legacy?: boolean;
};

export const MODELS: readonly Model[] = [
  { id: "opus", label: "Opus 4.7 1M", group: "Claude Code", extraUsage: true },
  { id: "claude-opus-4-7", label: "Opus 4.7", group: "Claude Code", extraUsage: false },
  { id: "sonnet", label: "Sonnet 4.6", group: "Claude Code", extraUsage: false },
  { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 1M", group: "Claude Code", extraUsage: true },
  { id: "haiku", label: "Haiku 4.5", group: "Claude Code", extraUsage: false },
  { id: "claude-opus-4-6", label: "Opus 4.6", group: "Claude Code", extraUsage: false, legacy: true },
  { id: "claude-opus-4-6[1m]", label: "Opus 4.6 1M", group: "Claude Code", extraUsage: true, legacy: true },
  { id: "claude-opus-4-5", label: "Opus 4.5", group: "Claude Code", extraUsage: false, legacy: true },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5", group: "Claude Code", extraUsage: false, legacy: true },
  { id: "claude-haiku-3-5", label: "Haiku 3.5", group: "Claude Code", extraUsage: false, legacy: true },
];
