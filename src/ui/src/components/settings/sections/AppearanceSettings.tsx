import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../../stores/useAppStore";
import { setAppSetting } from "../../../services/tauri";
import { applyTheme, applyUserFonts, clearUserFont, loadAllThemes, findTheme } from "../../../utils/theme";
import {
  UI_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_DEFAULT,
  buildFontOptions,
} from "../../../utils/fontSettings";
import type { ThemeDefinition } from "../../../types/theme";
import { FontSelect } from "../FontSelect";
import styles from "../Settings.module.css";

export function AppearanceSettings() {
  const currentThemeId = useAppStore((s) => s.currentThemeId);
  const setCurrentThemeId = useAppStore((s) => s.setCurrentThemeId);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useAppStore((s) => s.setTerminalFontSize);
  const uiFontSize = useAppStore((s) => s.uiFontSize);
  const setUiFontSize = useAppStore((s) => s.setUiFontSize);
  const fontFamilySans = useAppStore((s) => s.fontFamilySans);
  const setFontFamilySans = useAppStore((s) => s.setFontFamilySans);
  const fontFamilyMono = useAppStore((s) => s.fontFamilyMono);
  const setFontFamilyMono = useAppStore((s) => s.setFontFamilyMono);
  const systemFonts = useAppStore((s) => s.systemFonts);

  const [availableThemes, setAvailableThemes] = useState<ThemeDefinition[]>([]);
  const [termFontSize, setTermFontSize] = useState(String(terminalFontSize));
  const [uiFontSizeStr, setUiFontSizeStr] = useState(String(uiFontSize));
  const [error, setError] = useState<string | null>(null);

  // Sync the UI font size input when it changes externally (Cmd+/-, View menu).
  useEffect(() => {
    setUiFontSizeStr(String(uiFontSize));
  }, [uiFontSize]);

  // Derive font option lists from the pre-loaded system fonts in the store.
  const { sans: sansFontOptions, mono: monoFontOptions } = useMemo(
    () => buildFontOptions(systemFonts),
    [systemFonts],
  );

  // Custom font input state — shown when "Custom..." is selected or
  // the stored font isn't in the system font list.
  const isCustomSans = fontFamilySans !== "" &&
    !sansFontOptions.some((o) => o.value === fontFamilySans);
  const isCustomMono = fontFamilyMono !== "" &&
    !monoFontOptions.some((o) => o.value === fontFamilyMono);
  const [showCustomSans, setShowCustomSans] = useState(false);
  const [showCustomMono, setShowCustomMono] = useState(false);
  const [customSans, setCustomSans] = useState("");
  const [customMono, setCustomMono] = useState("");

  // Sync custom state when system fonts load or stored font changes.
  useEffect(() => {
    setShowCustomSans(isCustomSans);
    setCustomSans(isCustomSans ? fontFamilySans : "");
  }, [isCustomSans, fontFamilySans]);
  useEffect(() => {
    setShowCustomMono(isCustomMono);
    setCustomMono(isCustomMono ? fontFamilyMono : "");
  }, [isCustomMono, fontFamilyMono]);

  useEffect(() => {
    loadAllThemes().then(setAvailableThemes).catch(() => {});
  }, []);

  const handleThemeChange = async (id: string) => {
    const theme = findTheme(availableThemes, id);
    applyTheme(theme);
    // Re-apply user font overrides on top of new theme.
    applyUserFonts(fontFamilySans, fontFamilyMono, uiFontSize);
    setCurrentThemeId(id);
    try {
      setError(null);
      await setAppSetting("theme", id);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleTermFontSizeBlur = async () => {
    const size = parseInt(termFontSize, 10);
    if (isNaN(size) || size < 8 || size > 24) {
      setTermFontSize(String(terminalFontSize));
      return;
    }
    if (size !== terminalFontSize) {
      try {
        setError(null);
        await setAppSetting("terminal_font_size", String(size));
        setTerminalFontSize(size);
      } catch (e) {
        setTermFontSize(String(terminalFontSize));
        setError(String(e));
      }
    }
  };

  const handleUiFontSizeBlur = async () => {
    const size = parseInt(uiFontSizeStr, 10);
    if (isNaN(size) || size < UI_FONT_SIZE_MIN || size > UI_FONT_SIZE_MAX) {
      setUiFontSizeStr(String(uiFontSize));
      return;
    }
    if (size !== uiFontSize) {
      try {
        setError(null);
        setUiFontSize(size);
        applyUserFonts(fontFamilySans, fontFamilyMono, size);
        await setAppSetting("ui_font_size", String(size));
      } catch (e) {
        setUiFontSizeStr(String(uiFontSize));
        setError(String(e));
      }
    }
  };

  const applyFontFamily = async (
    key: "font_family_sans" | "font_family_mono",
    value: string,
  ) => {
    try {
      setError(null);
      const cssVar = key === "font_family_sans" ? "font-sans" : "font-mono";
      if (key === "font_family_sans") {
        setFontFamilySans(value);
        if (value) {
          applyUserFonts(value, fontFamilyMono, uiFontSize);
        } else {
          clearUserFont(cssVar);
        }
      } else {
        setFontFamilyMono(value);
        if (value) {
          applyUserFonts(fontFamilySans, value, uiFontSize);
        } else {
          clearUserFont(cssVar);
        }
      }
      await setAppSetting(key, value);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleSansChange = (selectValue: string) => {
    if (selectValue === "__custom__") {
      setShowCustomSans(true);
      return;
    }
    setShowCustomSans(false);
    setCustomSans("");
    applyFontFamily("font_family_sans", selectValue);
  };

  const handleMonoChange = (selectValue: string) => {
    if (selectValue === "__custom__") {
      setShowCustomMono(true);
      return;
    }
    setShowCustomMono(false);
    setCustomMono("");
    applyFontFamily("font_family_mono", selectValue);
  };

  const handleCustomSansBlur = () => {
    const trimmed = customSans.trim();
    if (trimmed) {
      applyFontFamily("font_family_sans", trimmed);
    }
  };

  const handleCustomMonoBlur = () => {
    const trimmed = customMono.trim();
    if (trimmed) {
      applyFontFamily("font_family_mono", trimmed);
    }
  };

  const isMac =
    ((navigator as unknown as Record<string, unknown>).userAgentData as
      | { platform?: string }
      | undefined)
      ?.platform?.toLowerCase()
      .startsWith("mac") ?? navigator.platform.startsWith("Mac");
  const modKey = isMac ? "\u2318" : "Ctrl";

  return (
    <div>
      <h2 className={styles.sectionTitle}>Appearance</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Color theme</div>
          <div className={styles.settingDescription}>
            Add custom themes to ~/.claudette/themes/
          </div>
        </div>
        <div className={styles.settingControl}>
          <select
            className={styles.select}
            value={currentThemeId}
            onChange={(e) => handleThemeChange(e.target.value)}
          >
            {availableThemes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>UI font size</div>
          <div className={styles.settingDescription}>
            {UI_FONT_SIZE_MIN}–{UI_FONT_SIZE_MAX}px (default:{" "}
            {UI_FONT_SIZE_DEFAULT}). {modKey}+/– to adjust.
          </div>
        </div>
        <div className={styles.settingControl}>
          <input
            className={styles.numberInput}
            type="number"
            min={UI_FONT_SIZE_MIN}
            max={UI_FONT_SIZE_MAX}
            value={uiFontSizeStr}
            onChange={(e) => setUiFontSizeStr(e.target.value)}
            onBlur={handleUiFontSizeBlur}
          />
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Terminal font size</div>
          <div className={styles.settingDescription}>8–24px (default: 11)</div>
        </div>
        <div className={styles.settingControl}>
          <input
            className={styles.numberInput}
            type="number"
            min={8}
            max={24}
            value={termFontSize}
            onChange={(e) => setTermFontSize(e.target.value)}
            onBlur={handleTermFontSizeBlur}
          />
        </div>
      </div>

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Interface font</div>
          <div className={styles.settingDescription}>
            Font for UI text. Themes may set a default.
          </div>
        </div>
        <div className={styles.settingControl}>
          <FontSelect
            options={sansFontOptions}
            value={showCustomSans ? customSans : fontFamilySans}
            isCustom={showCustomSans}
            onChange={handleSansChange}
          />
        </div>
      </div>
      {showCustomSans && (
        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <div className={styles.settingLabel}>Custom interface font</div>
            <div className={styles.settingDescription}>
              Enter a font name installed on your system
            </div>
          </div>
          <div className={styles.settingControl}>
            <input
              className={styles.input}
              type="text"
              placeholder="e.g. Avenir Next"
              value={customSans}
              onChange={(e) => setCustomSans(e.target.value)}
              onBlur={handleCustomSansBlur}
            />
          </div>
        </div>
      )}

      <div className={styles.settingRow}>
        <div className={styles.settingInfo}>
          <div className={styles.settingLabel}>Monospace font</div>
          <div className={styles.settingDescription}>
            Font for terminal and code blocks.
          </div>
        </div>
        <div className={styles.settingControl}>
          <FontSelect
            options={monoFontOptions}
            value={showCustomMono ? customMono : fontFamilyMono}
            isCustom={showCustomMono}
            onChange={handleMonoChange}
            kind="mono"
          />
        </div>
      </div>
      {showCustomMono && (
        <div className={styles.settingRow}>
          <div className={styles.settingInfo}>
            <div className={styles.settingLabel}>Custom monospace font</div>
            <div className={styles.settingDescription}>
              Enter a font name installed on your system
            </div>
          </div>
          <div className={styles.settingControl}>
            <input
              className={styles.input}
              type="text"
              placeholder="e.g. Fira Code"
              value={customMono}
              onChange={(e) => setCustomMono(e.target.value)}
              onBlur={handleCustomMonoBlur}
            />
          </div>
        </div>
      )}
    </div>
  );
}
