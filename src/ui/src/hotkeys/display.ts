import type { HotkeyActionId } from "./actions";
import {
  formatBinding,
  formatBindingParts,
  getEffectiveBindingById,
  type KeybindingMap,
} from "./bindings";

export function getHotkeyLabel(
  actionId: HotkeyActionId,
  keybindings: KeybindingMap,
  isMac: boolean,
): string | null {
  const binding = getEffectiveBindingById(actionId, keybindings);
  return binding ? formatBinding(binding, isMac) : null;
}

export function getHotkeyParts(
  actionId: HotkeyActionId,
  keybindings: KeybindingMap,
  isMac: boolean,
): string[] | null {
  const binding = getEffectiveBindingById(actionId, keybindings);
  return binding ? formatBindingParts(binding, isMac) : null;
}

export function tooltipWithHotkey(
  tooltip: string,
  actionId: HotkeyActionId,
  keybindings: KeybindingMap,
  isMac: boolean,
): string {
  const label = getHotkeyLabel(actionId, keybindings, isMac);
  return label ? `${tooltip} (${label})` : tooltip;
}

export function tooltipAttributes(
  tooltip: string,
  actionId: HotkeyActionId,
  keybindings: KeybindingMap,
  isMac: boolean,
  placement: "top" | "bottom" = "top",
): { "data-tooltip": string; "data-tooltip-placement": "top" | "bottom" } {
  const label = tooltipWithHotkey(tooltip, actionId, keybindings, isMac);
  return {
    "data-tooltip": label,
    "data-tooltip-placement": placement,
  };
}
