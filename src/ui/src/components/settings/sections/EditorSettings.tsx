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
  // Lock the radios while a persistence write is in flight. Without this,
  // a rapid head→merge_base→head sequence whose first two writes both
  // reject would have the second catch roll the store back to merge_base,
  // even though the persisted value never left head — the UI would then
  // disagree with disk until the app is restarted.
  const [pending, setPending] = useState(false);

  const handleChange = async (value: GutterBase) => {
    if (pending) return;
    const previous = editorGitGutterBase;
    setEditorGitGutterBase(value);
    setPending(true);
    try {
      setError(null);
      await setAppSetting("editor_git_gutter_base", value);
    } catch (e) {
      setEditorGitGutterBase(previous);
      setError(String(e));
    } finally {
      setPending(false);
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
            disabled={pending}
            onChange={() => handleChange("head")}
          />
          <div>
            <div>{t("editor_gutter_base_head")}</div>
            <div className={styles.fieldHint}>
              {t("editor_gutter_base_head_desc")}
            </div>
          </div>
        </label>

        <label className={styles.radioLabel}>
          <input
            type="radio"
            name="editor-gutter-base"
            checked={editorGitGutterBase === "merge_base"}
            disabled={pending}
            onChange={() => handleChange("merge_base")}
          />
          <div>
            <div>{t("editor_gutter_base_merge_base")}</div>
            <div className={styles.fieldHint}>
              {t("editor_gutter_base_merge_base_desc")}
            </div>
          </div>
        </label>
      </div>
    </div>
  );
}
