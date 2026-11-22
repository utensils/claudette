import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import styles from "./ScrollToBottomPill.module.css";

interface ScrollToBottomPillProps {
  visible: boolean;
  onClick: () => void;
}

export const ScrollToBottomPill = memo(function ScrollToBottomPill({
  visible,
  onClick,
}: ScrollToBottomPillProps) {
  const { t } = useTranslation("chat");
  if (!visible) return null;
  return (
    <button
      className={styles.pill}
      onClick={onClick}
      aria-label={t("scroll_to_bottom")}
      type="button"
    >
      <ChevronDown size={14} />
      <span>{t("scroll_new_messages")}</span>
    </button>
  );
});
