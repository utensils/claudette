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
