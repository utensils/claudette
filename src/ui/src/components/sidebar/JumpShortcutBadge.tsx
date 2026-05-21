import { useAppStore } from "../../stores/useAppStore";
import { getHotkeyLabel } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import type { HotkeyActionId } from "../../hotkeys/actions";
import styles from "./Sidebar.module.css";

interface Props {
  /** 1-based slot in the sidebar; only 1..9 are bound to a shortcut. */
  number: number;
  className?: string;
}

/**
 * The hold-`Cmd` jump-shortcut badge ("⌘3", "Ctrl+3", ...) that fades in
 * on top of a repo or workspace row when the user is hinting at the
 * jump-to shortcut. Shared by the repo-mode badge on project headers and
 * the status-mode badge on workspace rows so both surfaces look identical.
 */
export function JumpShortcutBadge({ number, className }: Props) {
  const metaKeyHeld = useAppStore((s) => s.metaKeyHeld);
  const keybindings = useAppStore((s) => s.keybindings);
  if (number < 1 || number > 9) return null;
  const isMac = isMacHotkeyPlatform();
  const actionId = `global.jump-to-project-${number}` as HotkeyActionId;
  const label = getHotkeyLabel(actionId, keybindings, isMac);
  if (!label) return null;
  return (
    <kbd
      aria-hidden="true"
      className={`${styles.shortcutBadge} ${metaKeyHeld ? styles.shortcutBadgeVisible : ""}${className ? ` ${className}` : ""}`}
    >
      {label}
    </kbd>
  );
}
