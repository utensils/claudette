import { useTranslation } from "react-i18next";
import styles from "../Settings.module.css";

interface PlaceholderSettingsProps {
  title: string;
}

export function PlaceholderSettings({ title }: PlaceholderSettingsProps) {
  const { t } = useTranslation("settings");
  return (
    <div>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <div className={styles.placeholder}>{t("placeholder_coming_soon")}</div>
    </div>
  );
}
