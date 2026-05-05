import { findHotkeyAction, HOTKEY_ACTIONS, type HotkeyAction, type HotkeyActionId, type HotkeyScope } from "./actions";
import { getHotkeyPlatform, type HotkeyPlatform } from "./platform";

export type KeybindingMap = Record<string, string | null | undefined>;

export const KEYBINDING_SETTING_PREFIX = "keybinding:";

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph"]);

/** Event `code` values that ARE themselves a modifier. Pressing them asserts
 * the corresponding `e.altKey`/`e.shiftKey`/etc. flag, so a binding like
 * `code:AltRight` (used for hold-to-talk on Right Alt) must not require the
 * `alt` modifier flag to be absent — it would always be present. */
const MODIFIER_CODE_TO_FLAG: Record<string, "alt" | "shift" | "mod"> = {
  altleft: "alt",
  altright: "alt",
  shiftleft: "shift",
  shiftright: "shift",
  controlleft: "mod",
  controlright: "mod",
  metaleft: "mod",
  metaright: "mod",
};

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

  // When the bound key is itself a modifier (e.g. `code:AltRight` for
  // hold-to-talk), pressing it asserts the matching modifier flag on the
  // event. Mask out that flag from the equality check so the binding
  // resolves on its own — without forcing the user to also tick the
  // implicit modifier in the rebind UI.
  const selfMod = parsed.match === "code" ? MODIFIER_CODE_TO_FLAG[parsed.key] : undefined;
  const eventShift = selfMod === "shift" ? parsed.shift : e.shiftKey;
  const eventAlt = selfMod === "alt" ? parsed.alt : e.altKey;
  const eventMod = selfMod === "mod" ? parsed.mod : hasMod;

  return (
    parsed.mod === eventMod &&
    parsed.shift === eventShift &&
    parsed.alt === eventAlt
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
