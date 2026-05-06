import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { HOTKEY_ACTIONS, type HotkeyAction } from "../../hotkeys/actions";
import {
  formatBindingParts,
  getEffectiveBinding,
} from "../../hotkeys/bindings";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import { shortcutMatchesQuery } from "../settings/sections/keyboardSearch";
import styles from "./KeyboardShortcutsModal.module.css";

export function KeyboardShortcutsModal() {
  const { t } = useTranslation("settings");
  // The hotkey table stores i18n keys (e.g. `keyboard_action_show_shortcuts`)
  // in `description` and `category`. `t` is typed against a key union, so
  // pass an unchecked key through `tx` rather than fight the generics.
  const tx = (key: string) => t(key as never);
  const closeModal = useAppStore((s) => s.closeModal);
  const keybindings = useAppStore((s) => s.keybindings);
  const isMac = isMacHotkeyPlatform();
  const [search, setSearch] = useState("");

  const groupedActions = useMemo(() => {
    const groups = new Map<string, HotkeyAction[]>();
    for (const action of HOTKEY_ACTIONS) {
      const description = tx(action.description);
      const category = tx(action.category);
      const effective = getEffectiveBinding(action, keybindings);
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
    // `tx` is a stable wrapper around i18n's `t` — re-creating each render
    // is fine and lets the filter respond to language changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, keybindings, isMac, t]);

  return (
    <div className={styles.backdrop} onClick={closeModal}>
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts_modal_title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h3 className={styles.title}>{t("shortcuts_modal_title")}</h3>
        </div>
        <div className={styles.body}>
          <input
            type="search"
            className={styles.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("keyboard_search_placeholder")}
            aria-label={t("keyboard_search_placeholder")}
            autoFocus
          />

          {groupedActions.length === 0 ? (
            <div className={styles.empty}>{t("keyboard_no_results")}</div>
          ) : null}

          {groupedActions.map(([category, actions]) => (
            <div className={styles.group} key={category}>
              <div className={styles.groupLabel}>{tx(category)}</div>
              {actions.map((action) => {
                const effective = getEffectiveBinding(action, keybindings);
                const parts = formatBindingParts(effective, isMac);
                return (
                  <div className={styles.row} key={action.id}>
                    <div className={styles.label}>{tx(action.description)}</div>
                    <div className={styles.binding}>
                      {effective === null ? (
                        <span className={styles.unbound}>
                          {t("keyboard_disabled_binding")}
                        </span>
                      ) : (
                        parts.map((part, index) => (
                          <span
                            className={styles.keycap}
                            key={`${part}-${index}`}
                          >
                            {part}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
