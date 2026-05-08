import type { ClaudeFlagDef } from "../../../services/claudeFlags";

export type FlagRowScope = "global" | "repo";

/// Decide which kind of input the row should render for the value side.
/// Pure helper so tests can verify the decision without a DOM.
export type FlagInputKind = "none" | "text" | "select";

export function flagInputKind(def: ClaudeFlagDef): FlagInputKind {
  if (!def.takes_value) return "none";
  if (def.enum_choices && def.enum_choices.length > 0) return "select";
  return "text";
}

/// `true` when the row's controls (checkbox, value input) should be
/// disabled because the user hasn't chosen to override global yet.
export function rowIsReadOnly(
  scope: FlagRowScope,
  isOverride: boolean | undefined,
): boolean {
  if (scope !== "repo") return false;
  return !isOverride;
}
