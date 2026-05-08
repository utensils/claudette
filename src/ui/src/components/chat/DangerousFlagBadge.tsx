import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

interface DangerousFlagBadgeProps {
  active: boolean;
}

/**
 * Tab-strip badge that warns when `--dangerously-skip-permissions` is
 * enabled for the workspace. Returns null when inactive so the tab layout
 * is unchanged in the common case.
 */
export function DangerousFlagBadge({ active }: DangerousFlagBadgeProps) {
  const { t } = useTranslation("settings");
  if (!active) return null;
  const label = t("claude_flags_tab_badge_tooltip");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        color: "var(--diff-removed-text)",
      }}
    >
      <ShieldAlert size={12} />
    </span>
  );
}
