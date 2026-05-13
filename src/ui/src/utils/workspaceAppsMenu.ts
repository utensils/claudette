import type { AppCategory, DetectedApp } from "../types/apps";

// Order in which app categories are laid out wherever we render the full
// detected-app list (the workspace "Open in app" menu, the Apps settings
// section). Apps within a category keep their detection order.
export const CATEGORY_ORDER: AppCategory[] = [
  "editor",
  "file_manager",
  "terminal",
  "ide",
];

export function appsInCategoryOrder(apps: DetectedApp[]): DetectedApp[] {
  return CATEGORY_ORDER.flatMap((category) =>
    apps.filter((app) => app.category === category),
  );
}

export interface MenuApps {
  /** Apps surfaced directly in the top level of the menu, in display order. */
  shown: DetectedApp[];
  /** Apps reachable via the "More" flyout, in category order. */
  more: DetectedApp[];
}

/**
 * Split detected apps into the top-level list and the "More" overflow.
 *
 * `shownIds === null` (the default, unconfigured state) — and, defensively,
 * any non-array value — means "show every detected app": `more` is empty and
 * the menu behaves exactly as before. Once curated, `shownIds` is an ordered
 * allowlist; stale IDs are dropped, duplicates collapsed, and any detected app
 * not in the list (including newly-installed ones) lands in `more`, keeping the
 * curated top level stable.
 */
export function splitMenuApps(
  detectedApps: DetectedApp[],
  shownIds: string[] | null,
): MenuApps {
  const ordered = appsInCategoryOrder(detectedApps);
  if (!Array.isArray(shownIds)) {
    return { shown: ordered, more: [] };
  }
  const byId = new Map(detectedApps.map((app) => [app.id, app]));
  const shown: DetectedApp[] = [];
  const seen = new Set<string>();
  for (const id of shownIds) {
    const app = byId.get(id);
    if (app && !seen.has(id)) {
      shown.push(app);
      seen.add(id);
    }
  }
  const more = ordered.filter((app) => !seen.has(app.id));
  return { shown, more };
}

export function preferredPrimaryApp(menu: MenuApps): DetectedApp | null {
  return menu.shown[0] ?? menu.more[0] ?? null;
}
