import type { ClaudeFlagDef, FlagValue } from "./claudeFlags";

export interface ResolvedFlag {
  name: string;
  value?: string;
  isDangerous: boolean;
}

const DANGEROUS_FLAG = "--dangerously-skip-permissions";

/// Mirror of `claudette::claude_flags_store::resolve_for_repo`. Repo state is
/// the entries that have the `:override` sentinel set — the backend already
/// filters by that, so any key present here wins over the matching global
/// entry. Disabled flags are excluded; flags absent from `defs` are skipped;
/// boolean flags emit `undefined` for value even if a stale value persists.
export function resolveEnabledExtraFlags(
  defs: ClaudeFlagDef[],
  globalState: Record<string, FlagValue>,
  repoState: Record<string, FlagValue>,
): ResolvedFlag[] {
  const out: ResolvedFlag[] = [];
  for (const def of defs) {
    const chosen = repoState[def.name] ?? globalState[def.name];
    if (!chosen) continue;
    if (!chosen.enabled) continue;
    out.push({
      name: def.name,
      value: def.takes_value ? (chosen.value ?? "") : undefined,
      isDangerous: def.is_dangerous,
    });
  }
  return out;
}

export function hasDangerousFlag(resolved: ResolvedFlag[]): boolean {
  return resolved.some((f) => f.name === DANGEROUS_FLAG);
}

/// True iff the rejection is the Tauri-side "still loading" sentinel from
/// `list_claude_flags`. Couples this guard to the literal Rust message —
/// alternative would be a typed payload across the boundary, much more
/// surface area for marginal gain. If the message text changes, the guard
/// silently degrades to "show error banner" (UX papercut, not correctness).
export function isStillLoading(e: unknown): boolean {
  return e instanceof Error && /still loading/i.test(e.message);
}
