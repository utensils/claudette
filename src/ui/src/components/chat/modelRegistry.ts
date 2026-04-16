/**
 * Model registry — the canonical list of models the UI exposes.
 *
 * Lives in a non-React module so logic that only needs the metadata
 * (slash command validation, toolbar state normalization) can import it
 * without dragging in component CSS or React deps.
 */
export const MODELS = [
  { id: "opus", label: "Opus 4.7 1M", group: "Claude Code", extraUsage: true },
  { id: "claude-opus-4-7", label: "Opus 4.7", group: "Claude Code", extraUsage: false },
  { id: "claude-opus-4-6", label: "Opus 4.6", group: "Claude Code", extraUsage: false },
  { id: "sonnet", label: "Sonnet 4.6", group: "Claude Code", extraUsage: false },
  { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 1M", group: "Claude Code", extraUsage: true },
  { id: "haiku", label: "Haiku 4.5", group: "Claude Code", extraUsage: false },
] as const;

export type Model = (typeof MODELS)[number];
