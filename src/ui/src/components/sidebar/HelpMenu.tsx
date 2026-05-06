import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { CircleHelp, Keyboard, BookOpen, FileText, ArrowUpRight, Wrench } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { openDevtools, openUrl } from "../../services/tauri";
import { findHotkeyAction } from "../../hotkeys/actions";
import { formatBindingParts, getEffectiveBinding } from "../../hotkeys/bindings";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import { viewportLayoutSize, viewportToFixed } from "../../utils/zoom";
import styles from "./HelpMenu.module.css";

const DOCS_URL = "https://utensils.io/claudette/getting-started/installation/";
const RELEASE_URL_BASE = "https://github.com/utensils/claudette/releases/tag/v";

// Spacing between the trigger button and the menu's edge, in viewport px.
// Tight on purpose — the menu reads as "anchored to the ? button" rather
// than floating in the middle of the sidebar/chat boundary.
const MENU_GAP = 2;
// Safety margin from viewport edges when clamping.
const VIEWPORT_MARGIN = 8;

interface HelpMenuProps {
  buttonClassName: string;
  triggerLabel: string;
}

interface MenuPosition {
  left: number;
  top: number;
}

export function HelpMenu({ buttonClassName, triggerLabel }: HelpMenuProps) {
  const { t } = useTranslation("settings");
  const openModal = useAppStore((s) => s.openModal);
  const keybindings = useAppStore((s) => s.keybindings);
  const isMac = isMacHotkeyPlatform();
  const [open, setOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || appVersion) return;
    getVersion().then(setAppVersion).catch(() => {});
  }, [open, appVersion]);

  // Compute fixed-viewport position from the trigger's rect. Uses
  // useLayoutEffect so the menu lands at the right spot before paint,
  // avoiding a flash at (0,0). We re-measure on resize/scroll so the
  // menu follows its anchor if the layout shifts while open.
  //
  // No reset to null when closing — the menu unmounts via the `open`
  // guard, so stale position is invisible, and on reopen this effect
  // runs synchronously before paint and overwrites the value.
  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      // `getBoundingClientRect()` returns visual (post-zoom) pixels, but
      // `position: fixed; left/top` interprets values as layout (pre-zoom)
      // pixels — `viewportToFixed` reconciles the two when the html zoom
      // (set by applyUserFonts) is != 1. `viewportLayoutSize` does the
      // same for the clamping bounds. AttachmentContextMenu has the same
      // dance for the same reason.
      const triggerRect = trigger.getBoundingClientRect();
      const triggerTop = viewportToFixed(triggerRect.left, triggerRect.top);
      const triggerBottom = viewportToFixed(
        triggerRect.right,
        triggerRect.bottom,
      );
      const menu = menuRef.current;
      // First paint: menu hasn't rendered yet, fall back to a generous
      // estimate so we land roughly correct, then refine on the next
      // tick once we can measure the actual menu.
      const menuWidth = menu?.offsetWidth ?? 240;
      const menuHeight = menu?.offsetHeight ?? 180;
      const { width: vw, height: vh } = viewportLayoutSize();
      // Anchor: open above the trigger (footer is at bottom of sidebar)
      // with the menu's left edge aligned to the trigger's left edge.
      let left = triggerTop.x;
      let top = triggerTop.y - menuHeight - MENU_GAP;
      // Clamp horizontally so the right edge stays inside the viewport.
      left = Math.min(left, vw - menuWidth - VIEWPORT_MARGIN);
      left = Math.max(VIEWPORT_MARGIN, left);
      // If there's not enough room above, drop below the trigger.
      if (top < VIEWPORT_MARGIN) {
        top = triggerBottom.y + MENU_GAP;
      }
      // Final vertical clamp (handles tiny viewports).
      top = Math.min(top, vh - menuHeight - VIEWPORT_MARGIN);
      top = Math.max(VIEWPORT_MARGIN, top);
      setPosition({ left, top });
    };
    compute();
    // Re-measure once the menu has actually rendered so we use its real
    // size rather than the estimate.
    const id = window.requestAnimationFrame(compute);
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open]);

  // Close on Escape and outside click. The trigger and the portaled menu
  // both count as "inside" — without that, clicking the menu's items
  // would race the outside-click handler and unmount before onClick ran.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const shortcutsAction = findHotkeyAction("global.show-keyboard-shortcuts");
  const shortcutBinding = shortcutsAction
    ? getEffectiveBinding(shortcutsAction, keybindings)
    : null;
  const shortcutParts = formatBindingParts(shortcutBinding, isMac);

  const handleShortcuts = () => {
    setOpen(false);
    openModal("keyboard-shortcuts");
  };

  const handleDocs = () => {
    setOpen(false);
    void openUrl(DOCS_URL).catch(() => {});
  };

  const handleChangelog = () => {
    setOpen(false);
    if (!appVersion) return;
    void openUrl(`${RELEASE_URL_BASE}${appVersion}`).catch(() => {});
  };

  const handleDevtools = () => {
    setOpen(false);
    void openDevtools().catch((err) =>
      console.warn("Failed to open devtools:", err),
    );
  };

  const menu = open ? (
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        // Hide until the first measurement lands so users never see a
        // (0,0) flash in the top-left corner.
        visibility: position ? "visible" : "hidden",
      }}
    >
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={handleShortcuts}
      >
        <span className={styles.itemLeft}>
          <Keyboard size={14} className={styles.itemIcon} />
          <span className={styles.itemLabel}>
            {t("help_menu_keyboard_shortcuts")}
          </span>
        </span>
        {shortcutBinding && (
          <span className={styles.shortcut} aria-hidden="true">
            {shortcutParts.map((part, i) => (
              <span className={styles.keycap} key={`${part}-${i}`}>
                {part}
              </span>
            ))}
          </span>
        )}
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={handleDocs}
      >
        <span className={styles.itemLeft}>
          <BookOpen size={14} className={styles.itemIcon} />
          <span className={styles.itemLabel}>{t("help_menu_docs")}</span>
        </span>
        <ArrowUpRight size={12} className={styles.externalIcon} />
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={handleChangelog}
        disabled={!appVersion}
      >
        <span className={styles.itemLeft}>
          <FileText size={14} className={styles.itemIcon} />
          <span className={styles.itemLabel}>{t("help_menu_changelog")}</span>
        </span>
        <ArrowUpRight size={12} className={styles.externalIcon} />
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.item}
        onClick={handleDevtools}
      >
        <span className={styles.itemLeft}>
          <Wrench size={14} className={styles.itemIcon} />
          <span className={styles.itemLabel}>{t("help_menu_devtools")}</span>
        </span>
      </button>
      {appVersion && (
        <>
          <div className={styles.divider} />
          <div className={styles.versionFooter}>Claudette v{appVersion}</div>
        </>
      )}
    </div>
  ) : null;

  return (
    <span className={styles.helpAnchor}>
      <button
        ref={triggerRef}
        type="button"
        className={buttonClassName}
        onClick={() => setOpen((v) => !v)}
        title={triggerLabel}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <CircleHelp size={16} />
      </button>
      {menu && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : menu}
    </span>
  );
}
