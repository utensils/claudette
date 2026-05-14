// Maps an env-provider plugin name onto one of the 8 category-slot
// tokens (--category-a-fg … --category-h-fg). Bundled providers get
// stable assignments so muscle memory holds across sessions; third-
// party providers cycle through the remaining slots via a stable hash
// so two custom providers get distinct colors (rather than both
// fingerprinting to the same slot).
//
// The category-* tokens live in src/styles/theme.css and ship a full
// bg/border/fg triplet — this module only returns the fg color since
// the row indicator is a 3px vertical bar (no fill or outline).

const BUNDLED_ASSIGNMENTS: Record<string, "a" | "b" | "c" | "d"> = {
  "env-direnv": "a",
  "env-mise": "b",
  "env-nix-devshell": "c",
  "env-dotenv": "d",
};

// Third-party providers cycle through E–H. Keep this set in sync with
// the category-slot count in theme.css so we never reach for a slot
// that doesn't exist.
const FALLBACK_SLOTS = ["e", "f", "g", "h"] as const;

function hashName(name: string): number {
  // FNV-1a 32-bit. Cheap, stable, no Math.random — same plugin name
  // always lands in the same slot across launches.
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Return the CSS var name for an env-provider row's category color, or
 * `null` if no category slot should be applied (e.g. a degraded state
 * where coloring would clash with the existing error/disabled visuals).
 *
 * Caller use:
 *
 *     const accent = envProviderCategoryColor("env-mise");
 *     // → "var(--category-b-fg)"
 */
export function envProviderCategoryColor(pluginName: string): string {
  const bundled = BUNDLED_ASSIGNMENTS[pluginName];
  if (bundled) {
    return `var(--category-${bundled}-fg)`;
  }
  const slot = FALLBACK_SLOTS[hashName(pluginName) % FALLBACK_SLOTS.length];
  return `var(--category-${slot}-fg)`;
}
