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

/**
 * Same as `tooltipWithHotkey`, but returns `undefined` instead of the bare
 * tooltip when the action has no resolvable binding. Use this anywhere the
 * tooltip exists solely to advertise the shortcut (sidebar jump badges,
 * etc.) — without the gate, unbinding the action would leave the row
 * advertising a non-existent jump.
 */
export function tooltipForBoundHotkey(
  tooltip: string,
  actionId: HotkeyActionId,
  keybindings: KeybindingMap,
  isMac: boolean,
): string | undefined {
  const label = getHotkeyLabel(actionId, keybindings, isMac);
  return label ? `${tooltip} (${label})` : undefined;
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
