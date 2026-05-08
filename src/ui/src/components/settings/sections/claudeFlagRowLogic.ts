import type { ClaudeFlagDef } from "../../../services/claudeFlags";

export type FlagRowScope = "global" | "repo";

/// Visual + behavioural variant chosen by the parent. Replaces the older
/// "is this read-only?" boolean: with the redesigned UI a row's role is
/// driven by which section it lives in (configured vs inherited vs browse),
/// not by a per-row override toggle.
export type FlagRowVariant =
  | "configured" // global scope, flag is in state.global — fully editable
  | "repo-override" // repo scope, flag is in state.repo — fully editable
  | "inherited" // repo scope, read-only mirror of a global entry
  | "browse"; // not configured at this scope yet — action button only

export type FlagInputKind = "none" | "text" | "select";

export function flagInputKind(def: ClaudeFlagDef): FlagInputKind {
  if (!def.takes_value) return "none";
  if (def.enum_choices && def.enum_choices.length > 0) return "select";
  return "text";
}

/// Variants that let the user toggle the enabled checkbox / edit the value.
/// Inherited rows mirror global state read-only; browse rows have no value
/// input at all (they expose only an action button to promote into one of
/// the editable variants).
export function rowVariantIsEditable(variant: FlagRowVariant): boolean {
  return variant === "configured" || variant === "repo-override";
}
