import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import { setAppSetting } from "../../../services/tauri";
import {
  DEFAULT_HOLD_HOTKEY,
  DEFAULT_TOGGLE_HOTKEY,
  formatHoldHotkey,
  formatToggleHotkey,
  normalizeToggleKey,
} from "../../../hooks/useVoiceHotkey";
import styles from "../Settings.module.css";

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent);
}

type RebindTarget = "toggle" | "hold" | null;

/** Capture a toggle-hotkey combo from a keydown event. Returns null for modifier-only presses. */
function captureToggleCombo(e: KeyboardEvent): string | null {
  const modifierKeys = new Set(["Meta", "Control", "Shift", "Alt"]);
  if (modifierKeys.has(e.key)) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  // Use normalizeToggleKey so "+" doesn't collide with the "+" delimiter.
  parts.push(normalizeToggleKey(e.key));
  return parts.join("+");
}

export function KeyboardSettings() {
  const { t } = useTranslation("settings");
  const isMac = isMacPlatform();

  const voiceToggleHotkey = useAppStore((s) => s.voiceToggleHotkey);
  const voiceHoldHotkey = useAppStore((s) => s.voiceHoldHotkey);
  const setVoiceToggleHotkey = useAppStore((s) => s.setVoiceToggleHotkey);
  const setVoiceHoldHotkey = useAppStore((s) => s.setVoiceHoldHotkey);

  const [rebinding, setRebinding] = useState<RebindTarget>(null);
  const [error, setError] = useState<string | null>(null);

  const saveToggleHotkey = async (value: string | null) => {
    try {
      await setAppSetting("voice_toggle_hotkey", value ?? "disabled");
      setVoiceToggleHotkey(value);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    setRebinding(null);
  };

  const saveHoldHotkey = async (value: string | null) => {
    try {
      await setAppSetting("voice_hold_hotkey", value ?? "disabled");
      setVoiceHoldHotkey(value);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    setRebinding(null);
  };

  // Capture key presses while rebinding is active.
  // Uses capture phase so the listener fires before other handlers.
  // Deps: rebinding (changes when entering/leaving rebind mode), stable Zustand setters.
  useEffect(() => {
    if (!rebinding) return;

    // Closure-local guard: setRebinding(null) doesn't synchronously unregister
    // this listener (state update + re-render is async), so without this flag a
    // burst of keydowns between the await and the next render could fire
    // multiple persist() calls and overwrite the intended binding.
    let captured = false;

    const persist = async (settingKey: string, value: string | null, storeSetter: (v: string | null) => void) => {
      try {
        await setAppSetting(settingKey, value ?? "disabled");
        storeSetter(value);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
      setRebinding(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (captured) return;

      if (e.key === "Escape") {
        captured = true;
        setRebinding(null);
        return;
      }

      if (rebinding === "toggle") {
        const combo = captureToggleCombo(e);
        if (!combo) return; // modifier-only press — keep listening
        captured = true;
        void persist("voice_toggle_hotkey", combo, setVoiceToggleHotkey);
      } else {
        captured = true;
        void persist("voice_hold_hotkey", e.code, setVoiceHoldHotkey);
      }
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [rebinding, setVoiceToggleHotkey, setVoiceHoldHotkey]);

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("keyboard_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("keyboard_voice_section")}</div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("keyboard_voice_toggle_label")}</div>
          <div className={styles.settingDescription}>
            {t("keyboard_voice_toggle_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <code className={styles.hotkeyBadge}>
              {rebinding === "toggle"
                ? t("keyboard_press_key")
                : formatToggleHotkey(voiceToggleHotkey, isMac)}
            </code>
            {rebinding === "toggle" ? (
              <button className={styles.iconBtn} onClick={() => setRebinding(null)}>
                {t("keyboard_cancel")}
              </button>
            ) : (
              <>
                <button className={styles.iconBtn} onClick={() => setRebinding("toggle")}>
                  {t("keyboard_rebind")}
                </button>
                <button
                  className={styles.iconBtn}
                  onClick={() => void saveToggleHotkey(DEFAULT_TOGGLE_HOTKEY)}
                  disabled={voiceToggleHotkey === DEFAULT_TOGGLE_HOTKEY}
                >
                  {t("keyboard_reset")}
                </button>
                <button
                  className={styles.iconBtn}
                  onClick={() => void saveToggleHotkey(null)}
                  disabled={voiceToggleHotkey === null}
                >
                  {t("keyboard_disable")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>{t("keyboard_voice_hold_label")}</div>
          <div className={styles.settingDescription}>
            {t("keyboard_voice_hold_desc")}
          </div>
        </div>
        <div className={styles.settingControl}>
          <div className={styles.inlineControl}>
            <code className={styles.hotkeyBadge}>
              {rebinding === "hold"
                ? t("keyboard_press_key")
                : formatHoldHotkey(voiceHoldHotkey, isMac)}
            </code>
            {rebinding === "hold" ? (
              <button className={styles.iconBtn} onClick={() => setRebinding(null)}>
                {t("keyboard_cancel")}
              </button>
            ) : (
              <>
                <button className={styles.iconBtn} onClick={() => setRebinding("hold")}>
                  {t("keyboard_rebind")}
                </button>
                <button
                  className={styles.iconBtn}
                  onClick={() => void saveHoldHotkey(DEFAULT_HOLD_HOTKEY)}
                  disabled={voiceHoldHotkey === DEFAULT_HOLD_HOTKEY}
                >
                  {t("keyboard_reset")}
                </button>
                <button
                  className={styles.iconBtn}
                  onClick={() => void saveHoldHotkey(null)}
                  disabled={voiceHoldHotkey === null}
                >
                  {t("keyboard_disable")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
