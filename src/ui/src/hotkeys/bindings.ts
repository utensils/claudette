import { findHotkeyAction, HOTKEY_ACTIONS, type HotkeyAction, type HotkeyActionId, type HotkeyScope } from "./actions";
import { getHotkeyPlatform, type HotkeyPlatform } from "./platform";

export type KeybindingMap = Record<string, string | null | undefined>;

export const KEYBINDING_SETTING_PREFIX = "keybinding:";

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph"]);

function normalizeKey(key: string): string {
  if (key === "+") return "plus";
  if (key === " ") return "space";
  return key.toLowerCase();
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

export function getDefaultBinding(
  action: HotkeyAction,
  platform: HotkeyPlatform = getHotkeyPlatform(),
): string | null {
  return action.defaultBinding[platform] ?? null;
}

export function getEffectiveBinding(
  action: HotkeyAction,
  overrides: KeybindingMap,
  platform: HotkeyPlatform = getHotkeyPlatform(),
): string | null {
  const override = overrides[action.id];
  return override === undefined ? getDefaultBinding(action, platform) : override;
}

export function getEffectiveBindingById(
  id: string,
  overrides: KeybindingMap,
  platform: HotkeyPlatform = getHotkeyPlatform(),
): string | null {
  const action = findHotkeyAction(id);
  return action ? getEffectiveBinding(action, overrides, platform) : null;
}

interface ParsedBinding {
  key: string;
  match: "key" | "code";
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding.toLowerCase().split("+").filter(Boolean);
  const keyPart = parts[parts.length - 1];
  if (!keyPart) return null;
  const coded = keyPart.startsWith("code:");
  return {
    key: coded ? normalizeCode(binding.split("+").at(-1)!.slice("code:".length)) : keyPart,
    match: coded ? "code" : "key",
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
}

export function eventToBinding(
  e: KeyboardEvent,
  match: "key" | "code" = "key",
  platform: HotkeyPlatform = getHotkeyPlatform(),
): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const parts: string[] = [];
  const hasPlatformMod =
    platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const hasWrongMod = platform === "mac" ? e.ctrlKey : e.metaKey;
  if (hasWrongMod) return null;
  if (hasPlatformMod) parts.push("mod");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  const key = match === "code" ? `code:${e.code}` : normalizeKey(e.key);
  if (!key || key === "code:") return null;
  parts.push(key);
  return parts.join("+");
}

export function bindingMatchesEvent(
  binding: string | null,
  e: KeyboardEvent,
  platform: HotkeyPlatform = getHotkeyPlatform(),
): boolean {
  if (!binding) return false;
  const parsed = parseBinding(binding);
  if (!parsed) return false;
  const eventKey = parsed.match === "code" ? normalizeCode(e.code) : normalizeKey(e.key);
  if (eventKey !== parsed.key) return false;
  const hasMod = platform === "mac"
    ? e.metaKey && !e.ctrlKey
    : e.ctrlKey && !e.metaKey;
  return (
    parsed.mod === hasMod &&
    parsed.shift === e.shiftKey &&
    parsed.alt === e.altKey
  );
}

function scopeMatches(actionScope: HotkeyScope, scope: HotkeyScope): boolean {
  return actionScope === scope;
}

export function resolveHotkeyAction(
  e: KeyboardEvent,
  scope: HotkeyScope,
  overrides: KeybindingMap,
  platform: HotkeyPlatform = getHotkeyPlatform(),
): HotkeyActionId | null {
  for (const action of HOTKEY_ACTIONS) {
    if (!scopeMatches(action.scope, scope)) continue;
    if (bindingMatchesEvent(getEffectiveBinding(action, overrides, platform), e, platform)) {
      return action.id;
    }
  }
  return null;
}

export function buildRebindUpdates(
  targetActionId: string,
  binding: string | null,
  overrides: KeybindingMap,
  platform: HotkeyPlatform = getHotkeyPlatform(),
): Record<string, string | null> {
  const targetAction = findHotkeyAction(targetActionId);
  const updates: Record<string, string | null> = { [targetActionId]: binding };
  if (!binding || !targetAction) return updates;

  for (const action of HOTKEY_ACTIONS) {
    if (action.id === targetActionId || !action.rebindable) continue;
    if (action.scope !== targetAction.scope) continue;
    if (getEffectiveBinding(action, { ...overrides, ...updates }, platform) === binding) {
      updates[action.id] = null;
    }
  }

  return updates;
}

export function formatBinding(binding: string | null, isMac: boolean): string {
  return formatBindingParts(binding, isMac).join(isMac ? "" : "+");
}

export function formatBindingParts(binding: string | null, isMac: boolean): string[] {
  if (!binding) return ["-"];
  return binding
    .split("+")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "mod") return isMac ? "⌘" : "Ctrl";
      if (lower === "shift") return isMac ? "⇧" : "Shift";
      if (lower === "alt") return isMac ? "⌥" : "Alt";
      if (lower === "plus") return "+";
      if (lower === "space") return "Space";
      if (lower.startsWith("code:")) return formatCodeLabel(part.slice("code:".length));
      if (lower === "escape") return "Esc";
      if (lower === "tab") return "Tab";
      return part.length === 1 ? part.toUpperCase() : part;
    });
}

export function settingKeyForAction(id: string): string {
  return `${KEYBINDING_SETTING_PREFIX}${id}`;
}

function formatCodeLabel(code: string): string {
  const normalized = code.toLowerCase();
  const labels: Record<string, string> = {
    bracketleft: "[",
    bracketright: "]",
    backquote: "`",
    comma: ",",
    period: ".",
    slash: "/",
    semicolon: ";",
    quote: "'",
    equal: "=",
    minus: "-",
    space: "Space",
    altleft: "Left Alt",
    altright: "Right Alt",
    controlleft: "Left Ctrl",
    controlright: "Right Ctrl",
    metaleft: "Left ⌘",
    metaright: "Right ⌘",
    arrowleft: "←",
    arrowright: "→",
    arrowup: "↑",
    arrowdown: "↓",
  };
  if (labels[normalized]) return labels[normalized];
  return code.replace(/^(Key|Digit)/, "");
}
