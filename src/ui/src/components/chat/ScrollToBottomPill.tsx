import { memo } from "react";
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
  if (!visible) return null;
  return (
    <button
      className={styles.pill}
      onClick={onClick}
      aria-label="Scroll to bottom"
      type="button"
    >
      <ChevronDown size={14} />
      <span>New messages</span>
    </button>
  );
});
