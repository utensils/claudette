import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { HOTKEY_ACTIONS, type HotkeyAction } from "../../../hotkeys/actions";
import {
  buildRebindUpdates,
  eventToBinding,
  formatBindingParts,
  getEffectiveBinding,
  settingKeyForAction,
} from "../../../hotkeys/bindings";
import { isMacHotkeyPlatform } from "../../../hotkeys/platform";
import { useAppStore } from "../../../stores/useAppStore";
import { useSettingsOverlay } from "../../../hooks/useSettingsOverlay";
import { deleteAppSetting, setAppSetting } from "../../../services/tauri";
import styles from "../Settings.module.css";
import { shortcutMatchesQuery } from "./keyboardSearch";

function isCaptureMatchByCode(action: HotkeyAction): boolean {
  return action.match === "code" || action.holdMode === true;
}

function captureBinding(action: HotkeyAction, e: KeyboardEvent): string | null {
  if (action.holdMode) return e.code ? `code:${e.code}` : null;
  return eventToBinding(e, isCaptureMatchByCode(action) ? "code" : "key");
}

export function KeyboardSettings() {
  const { t } = useTranslation("settings");
  const tx = (key: string) => t(key as never);
  const isMac = isMacHotkeyPlatform();
  const keybindings = useAppStore((s) => s.keybindings);
  const setKeybinding = useAppStore((s) => s.setKeybinding);
  const resetKeybinding = useAppStore((s) => s.resetKeybinding);
  const setKeybindings = useAppStore((s) => s.setKeybindings);
  const [rebinding, setRebinding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useSettingsOverlay(rebinding !== null);

  const filteredActionsByCategory = useMemo(() => {
    const groups = new Map<string, HotkeyAction[]>();
    for (const action of HOTKEY_ACTIONS) {
      const description = tx(action.description);
      const category = tx(action.category);
      const effective = getEffectiveBinding(action, keybindings);
      // Include three representations of the binding so common query forms
      // all hit: "⌘ B" (visual / hint UI), "⌘B" (no separator), "⌘+B" / "Ctrl+B"
      // (cross-platform written form). The matcher AND-tokens its query, so
      // duplicating into one space-delimited string is safe — each variant
      // is its own searchable substring.
      const parts = formatBindingParts(effective, isMac);
      const bindingLabel = [
        parts.join(" "),
        parts.join(""),
        parts.join("+"),
      ].join(" ");
      if (!shortcutMatchesQuery({ description, category, bindingLabel }, search)) {
        continue;
      }
      const list = groups.get(action.category) ?? [];
      list.push(action);
      groups.set(action.category, list);
    }
    return Array.from(groups.entries());
    // `tx` is a stable wrapper around the i18n `t` function — re-running on
    // every render is fine and lets the filter respond to language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, keybindings, isMac, t]);

  const saveBinding = useCallback(async (action: HotkeyAction, binding: string | null) => {
    const updates = buildRebindUpdates(action.id, binding, keybindings);
    try {
      await Promise.all(
        Object.entries(updates).map(([actionId, nextBinding]) =>
          setAppSetting(settingKeyForAction(actionId), nextBinding ?? "disabled"),
        ),
      );
      for (const [actionId, nextBinding] of Object.entries(updates)) {
        setKeybinding(actionId, nextBinding);
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    setRebinding(null);
  }, [keybindings, setKeybinding]);

  const resetBinding = async (action: HotkeyAction) => {
    try {
      await deleteAppSetting(settingKeyForAction(action.id));
      resetKeybinding(action.id);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  const resetAllBindings = async () => {
    try {
      await Promise.all([
        ...HOTKEY_ACTIONS.map((action) => deleteAppSetting(settingKeyForAction(action.id))),
        deleteAppSetting("voice_toggle_hotkey"),
        deleteAppSetting("voice_hold_hotkey"),
      ]);
      setKeybindings({});
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    setRebinding(null);
  };

  useEffect(() => {
    if (!rebinding) return;
    const action = HOTKEY_ACTIONS.find((a) => a.id === rebinding);
    if (!action) return;
    let captured = false;

    const onKeyDown = (e: KeyboardEvent) => {
      if (captured) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        captured = true;
        setRebinding(null);
        return;
      }
      const binding = captureBinding(action, e);
      if (!binding) return;
      captured = true;
      void saveBinding(action, binding);
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [rebinding, saveBinding]);

  return (
    <div>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{t("keyboard_title")}</h2>
        <button
          className={styles.iconBtn}
          onClick={() => void resetAllBindings()}
          disabled={Object.keys(keybindings).length === 0}
        >
          {t("keyboard_reset_all")}
        </button>
      </div>
      {error && <div className={styles.error}>{error}</div>}

      <input
        type="search"
        className={styles.keyboardSearch}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("keyboard_search_placeholder")}
        aria-label={t("keyboard_search_placeholder")}
      />

      {filteredActionsByCategory.length === 0 ? (
        <div className={styles.keyboardEmpty}>{t("keyboard_no_results")}</div>
      ) : null}

      {filteredActionsByCategory.map(([category, actions]) => (
        <div className={styles.keyboardGroup} key={category}>
          <div className={styles.keyboardGroupLabel}>{tx(category)}</div>
          {actions.map((action) => {
            const effective = getEffectiveBinding(action, keybindings);
            const custom = Object.prototype.hasOwnProperty.call(keybindings, action.id);
            const isDisabled = effective === null;
            return (
              <div className={styles.settingRow} key={action.id}>
                <div className={styles.settingInfo}>
                  <div className={styles.settingLabel}>{tx(action.description)}</div>
                  {(custom || isDisabled || !action.rebindable) && (
                    <div className={styles.settingDescription}>
                      {isDisabled
                        ? t("keyboard_disabled_binding")
                        : action.rebindable
                          ? t("keyboard_custom_binding")
                          : t("keyboard_fixed_binding")}
                    </div>
                  )}
                </div>
                <div className={styles.settingControl}>
                  <div className={styles.inlineControl}>
                    <code className={styles.hotkeyBadge}>
                      {rebinding === action.id
                        ? t("keyboard_press_key")
                        : formatBindingParts(effective, isMac).map((part, index) => (
                            <span className={styles.keycap} key={`${part}-${index}`}>
                              {part}
                            </span>
                          ))}
                    </code>
                    {action.rebindable && rebinding === action.id ? (
                      <button className={styles.iconBtn} onClick={() => setRebinding(null)}>
                        {t("keyboard_cancel")}
                      </button>
                    ) : action.rebindable ? (
                      <>
                        <button className={styles.iconBtn} onClick={() => setRebinding(action.id)}>
                          {t("keyboard_rebind")}
                        </button>
                        <button
                          className={styles.iconBtn}
                          onClick={() => void resetBinding(action)}
                          disabled={!custom}
                        >
                          {t("keyboard_reset")}
                        </button>
                        <button
                          className={styles.iconBtn}
                          onClick={() => void saveBinding(action, null)}
                          disabled={isDisabled}
                        >
                          {t("keyboard_disable")}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
