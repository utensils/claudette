import { useEffect, useRef } from "react";
import { useAppStore } from "../stores/useAppStore";
import { getAppSetting, setAppSetting } from "../services/tauri";

// Persist sidebar / panel visibility + sizes + a couple of related view
// preferences across app restarts. State stays in Zustand (where the rest
// of the app reads it); this hook just bridges to the `app_settings` table
// on hydrate and on subsequent changes.
//
// All keys live under the `view:` namespace so they don't collide with
// the existing flat keys (`theme_mode`, `terminal_font_size`, etc.) and
// so a future cleanup can list+wipe them via list_app_settings_with_prefix.

const KEYS = {
  sidebarVisible: "view:sidebar_visible",
  rightSidebarVisible: "view:right_sidebar_visible",
  terminalPanelVisible: "view:terminal_panel_visible",
  sidebarWidth: "view:sidebar_width",
  rightSidebarWidth: "view:right_sidebar_width",
  terminalHeight: "view:terminal_height",
  rightSidebarTab: "view:right_sidebar_tab",
  sidebarGroupBy: "view:sidebar_group_by",
  sidebarShowArchived: "view:sidebar_show_archived",
} as const;

const RIGHT_SIDEBAR_TABS = ["files", "changes", "tasks"] as const;
type RightSidebarTab = (typeof RIGHT_SIDEBAR_TABS)[number];
const SIDEBAR_GROUP_BYS = ["status", "repo"] as const;
type SidebarGroupBy = (typeof SIDEBAR_GROUP_BYS)[number];

function parseBool(raw: string | null): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

function parseClampedInt(
  raw: string | null,
  min: number,
  max: number,
): number | null {
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export function useViewTogglePersistence() {
  // Selectors are split per-key so a change to one value only re-runs its
  // own write effect, not all of them.
  const sidebarVisible = useAppStore((s) => s.sidebarVisible);
  const rightSidebarVisible = useAppStore((s) => s.rightSidebarVisible);
  const terminalPanelVisible = useAppStore((s) => s.terminalPanelVisible);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const rightSidebarWidth = useAppStore((s) => s.rightSidebarWidth);
  const terminalHeight = useAppStore((s) => s.terminalHeight);
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab);
  const sidebarGroupBy = useAppStore((s) => s.sidebarGroupBy);
  const sidebarShowArchived = useAppStore((s) => s.sidebarShowArchived);

  // Track which keys have been hydrated. We only start writing back to
  // app_settings AFTER the corresponding hydration read completes, so the
  // first render's default values don't overwrite the user's saved state.
  const hydratedRef = useRef<Set<string>>(new Set());

  // ---- Hydrate on mount ----
  useEffect(() => {
    let cancelled = false;
    const store = useAppStore;
    void (async () => {
      try {
        const [
          sbVis,
          rsbVis,
          termVis,
          sbW,
          rsbW,
          termH,
          rsbTab,
          sbGroup,
          sbArch,
        ] = await Promise.all([
          getAppSetting(KEYS.sidebarVisible),
          getAppSetting(KEYS.rightSidebarVisible),
          getAppSetting(KEYS.terminalPanelVisible),
          getAppSetting(KEYS.sidebarWidth),
          getAppSetting(KEYS.rightSidebarWidth),
          getAppSetting(KEYS.terminalHeight),
          getAppSetting(KEYS.rightSidebarTab),
          getAppSetting(KEYS.sidebarGroupBy),
          getAppSetting(KEYS.sidebarShowArchived),
        ]);
        if (cancelled) return;
        // Apply each value if parseable. Direct setState (not setter
        // actions) so we don't fire any side-effects bound to the
        // setters; the actions are pure setters anyway, but bypassing
        // them keeps this hook's boundary tighter.
        const updates: Partial<ReturnType<typeof store.getState>> = {};
        const sbVisB = parseBool(sbVis);
        if (sbVisB !== null) updates.sidebarVisible = sbVisB;
        const rsbVisB = parseBool(rsbVis);
        if (rsbVisB !== null) updates.rightSidebarVisible = rsbVisB;
        const termVisB = parseBool(termVis);
        if (termVisB !== null) updates.terminalPanelVisible = termVisB;
        // Width/height clamps mirror the ResizeHandle min/max in
        // AppLayout — the persisted value should never let the user start
        // with an unrecoverable layout.
        const sbWN = parseClampedInt(sbW, 150, 600);
        if (sbWN !== null) updates.sidebarWidth = sbWN;
        const rsbWN = parseClampedInt(rsbW, 150, 600);
        if (rsbWN !== null) updates.rightSidebarWidth = rsbWN;
        const termHN = parseClampedInt(termH, 100, 800);
        if (termHN !== null) updates.terminalHeight = termHN;
        if (
          rsbTab &&
          (RIGHT_SIDEBAR_TABS as readonly string[]).includes(rsbTab)
        ) {
          updates.rightSidebarTab = rsbTab as RightSidebarTab;
        }
        if (
          sbGroup &&
          (SIDEBAR_GROUP_BYS as readonly string[]).includes(sbGroup)
        ) {
          updates.sidebarGroupBy = sbGroup as SidebarGroupBy;
        }
        const sbArchB = parseBool(sbArch);
        if (sbArchB !== null) updates.sidebarShowArchived = sbArchB;
        if (Object.keys(updates).length > 0) {
          store.setState(updates);
        }
      } catch (err) {
        console.error("[viewToggle] Failed to hydrate view state:", err);
      } finally {
        // Mark ALL keys hydrated even on partial failure so the write-back
        // effect can take over from here. The user's interactive changes
        // are more important than recovering a maybe-broken DB read.
        if (!cancelled) {
          for (const k of Object.values(KEYS)) hydratedRef.current.add(k);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Write back on change (post-hydration) ----
  // One effect per key; the dep array is just that key's value. The
  // hydration guard prevents the initial render from overwriting a saved
  // value with the slice's default.
  useEffect(() => {
    if (!hydratedRef.current.has(KEYS.sidebarVisible)) return;
    void setAppSetting(KEYS.sidebarVisible, String(sidebarVisible));
  }, [sidebarVisible]);
  useEffect(() => {
    if (!hydratedRef.current.has(KEYS.rightSidebarVisible)) return;
    void setAppSetting(KEYS.rightSidebarVisible, String(rightSidebarVisible));
  }, [rightSidebarVisible]);
  useEffect(() => {
    if (!hydratedRef.current.has(KEYS.terminalPanelVisible)) return;
    void setAppSetting(
      KEYS.terminalPanelVisible,
      String(terminalPanelVisible),
    );
  }, [terminalPanelVisible]);
  useEffect(() => {
    if (!hydratedRef.current.has(KEYS.sidebarWidth)) return;
    void setAppSetting(KEYS.sidebarWidth, String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    if (!hydratedRef.current.has(KEYS.rightSidebarWidth)) return;
    void setAppSetting(KEYS.rightSidebarWidth, String(rightSidebarWidth));
  }, [rightSidebarWidth]);
  useEffect(() => {
    if (!hydratedRef.current.has(KEYS.terminalHeight)) return;
    void setAppSetting(KEYS.terminalHeight, String(terminalHeight));
  }, [terminalHeight]);
  useEffect(() => {
    if (!hydratedRef.current.has(KEYS.rightSidebarTab)) return;
    void setAppSetting(KEYS.rightSidebarTab, rightSidebarTab);
  }, [rightSidebarTab]);
  useEffect(() => {
    if (!hydratedRef.current.has(KEYS.sidebarGroupBy)) return;
    void setAppSetting(KEYS.sidebarGroupBy, sidebarGroupBy);
  }, [sidebarGroupBy]);
  useEffect(() => {
    if (!hydratedRef.current.has(KEYS.sidebarShowArchived)) return;
    void setAppSetting(KEYS.sidebarShowArchived, String(sidebarShowArchived));
  }, [sidebarShowArchived]);
}
