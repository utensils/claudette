import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/useAppStore";
import { setAppSetting } from "../../../services/tauri";
import styles from "../Settings.module.css";

type GutterBase = "head" | "merge_base";

export function EditorSettings() {
  const { t } = useTranslation("settings");
  const editorGitGutterBase = useAppStore((s) => s.editorGitGutterBase);
  const setEditorGitGutterBase = useAppStore((s) => s.setEditorGitGutterBase);
  const [error, setError] = useState<string | null>(null);

  const handleChange = async (value: GutterBase) => {
    const previous = editorGitGutterBase;
    setEditorGitGutterBase(value);
    try {
      setError(null);
      await setAppSetting("editor_git_gutter_base", value);
    } catch (e) {
      setEditorGitGutterBase(previous);
      setError(String(e));
    }
  };

  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("editor_title")}</h2>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.fieldGroup}>
        <div className={styles.fieldLabel}>{t("editor_gutter_base_label")}</div>
        <div className={`${styles.fieldHint} ${styles.fieldHintSpacedWide}`}>
          {t("editor_gutter_base_desc")}
        </div>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="editor-gutter-base"
            checked={editorGitGutterBase === "head"}
            onChange={() => handleChange("head")}
          />
          <span>{t("editor_gutter_base_head")}</span>
        </label>
        <div className={styles.fieldHint}>
          {t("editor_gutter_base_head_desc")}
        </div>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="editor-gutter-base"
            checked={editorGitGutterBase === "merge_base"}
            onChange={() => handleChange("merge_base")}
          />
          <span>{t("editor_gutter_base_merge_base")}</span>
        </label>
        <div className={styles.fieldHint}>
          {t("editor_gutter_base_merge_base_desc")}
        </div>
      </div>
    </div>
  );
}
