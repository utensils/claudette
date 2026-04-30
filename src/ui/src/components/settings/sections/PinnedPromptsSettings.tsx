import { useTranslation } from "react-i18next";
import styles from "../Settings.module.css";
import { PinnedPromptsManager } from "./PinnedPromptsManager";

export function PinnedPromptsSettings() {
  const { t } = useTranslation("settings");
  return (
    <div>
      <h2 className={styles.sectionTitle}>{t("pinned_prompts_title")}</h2>
      <p className={styles.fieldHint} style={{ marginBottom: 24 }}>
        {t("pinned_prompts_global_description")}
      </p>
      <PinnedPromptsManager scope={{ kind: "global" }} />
    </div>
  );
}
