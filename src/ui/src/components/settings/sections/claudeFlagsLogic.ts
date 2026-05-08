import type {
  ClaudeFlagDef,
  FlagScope,
  FlagStateResponse,
  FlagValue,
} from "../../../services/claudeFlags";

export interface RowState {
  enabled: boolean;
  value: string;
  /// Repo scope only — `true` when the user has explicitly overridden global.
  isOverride: boolean;
}

/// Sort flags alphabetically by name. Pure helper so the test suite can
/// verify the ordering without rendering the component.
export function sortFlags(defs: ClaudeFlagDef[]): ClaudeFlagDef[] {
  return [...defs].sort((a, b) => a.name.localeCompare(b.name));
}

/// Compute the row state shown to the user for a given flag and scope.
/// Pure helper exposed for testing.
export function rowStateFor(
  def: ClaudeFlagDef,
  state: FlagStateResponse,
  scope: FlagScope,
): RowState {
  const global: FlagValue | undefined = state.global[def.name];
  const repo: FlagValue | undefined = state.repo[def.name];
  if (scope.kind === "repo") {
    if (repo) {
      return {
        enabled: repo.enabled,
        value: repo.value ?? "",
        isOverride: true,
      };
    }
    return {
      enabled: global?.enabled ?? false,
      value: global?.value ?? "",
      isOverride: false,
    };
  }
  return {
    enabled: global?.enabled ?? false,
    value: global?.value ?? "",
    isOverride: false,
  };
}

/// Partition shown to the user, derived from defs + state + scope.
///
/// At global scope, every flag falls into either `configured` (has an entry
/// in `state.global`) or `browse` (no entry yet). `inherited` and
/// `repoOverrides` are empty.
///
/// At repo scope, the picture mirrors the pinned-prompts inherited UX:
/// - `repoOverrides` holds entries the user has explicitly set on this repo
/// - `inherited` mirrors `state.global` so the user can see what's flowing
///   through; if a flag is also in `state.repo`, the inherited row stays
///   visible so the override badge has a place to land.
/// - `browse` is everything not configured at either scope — i.e. flags the
///   user could choose to override fresh on this repo.
export interface FlagPartition {
  configured: ClaudeFlagDef[];
  repoOverrides: ClaudeFlagDef[];
  inherited: ClaudeFlagDef[];
  browse: ClaudeFlagDef[];
}

export function partitionFlags(
  defs: ClaudeFlagDef[],
  state: FlagStateResponse,
  scope: FlagScope,
): FlagPartition {
  const sorted = sortFlags(defs);
  if (scope.kind === "global") {
    const configured: ClaudeFlagDef[] = [];
    const browse: ClaudeFlagDef[] = [];
    for (const def of sorted) {
      if (state.global[def.name]) configured.push(def);
      else browse.push(def);
    }
    return { configured, repoOverrides: [], inherited: [], browse };
  }
  const repoOverrides: ClaudeFlagDef[] = [];
  const inherited: ClaudeFlagDef[] = [];
  const browse: ClaudeFlagDef[] = [];
  for (const def of sorted) {
    const inRepo = state.repo[def.name] !== undefined;
    const inGlobal = state.global[def.name] !== undefined;
    if (inRepo) repoOverrides.push(def);
    if (inGlobal) inherited.push(def);
    if (!inRepo && !inGlobal) browse.push(def);
  }
  return { configured: [], repoOverrides, inherited, browse };
}

export type FlagFilterMode = "all" | "boolean" | "takes_value" | "dangerous";

/// Apply the search query + filter mode to a flag list. Search matches
/// case-insensitively against name, short, description, and enum choices —
/// good enough that typing "model" surfaces `--model` and typing "permis"
/// surfaces `--dangerously-skip-permissions`. Filter modes are mutually
/// exclusive on each call (the UI exposes a single dropdown).
export function filterFlags(
  defs: ClaudeFlagDef[],
  query: string,
  mode: FlagFilterMode,
): ClaudeFlagDef[] {
  const q = query.trim().toLowerCase();
  return defs.filter((def) => {
    if (mode === "boolean" && def.takes_value) return false;
    if (mode === "takes_value" && !def.takes_value) return false;
    if (mode === "dangerous" && !def.is_dangerous) return false;
    if (!q) return true;
    if (def.name.toLowerCase().includes(q)) return true;
    if (def.short && def.short.toLowerCase().includes(q)) return true;
    if (def.description.toLowerCase().includes(q)) return true;
    if (def.enum_choices?.some((c) => c.toLowerCase().includes(q))) return true;
    return false;
  });
}
