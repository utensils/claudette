import { useEffect, useRef } from "react";
import type { AppState } from "../stores/useAppStore";
import { useAppStore } from "../stores/useAppStore";
import { getAppSetting, setAppSetting } from "../services/tauri";
import { makeUnloadedBuffer, fileBufferKey } from "../stores/slices/fileTreeSlice";
import type { UnifiedTabEntry } from "../components/chat/sessionTabsLogic";
import type { DiffFileTab, DiffLayer, TerminalPaneNode, Workspace } from "../types";
import type { DiffSelection } from "../types/diff";

const VIEW_STATE_KEY = "view:state";
const VIEW_STATE_VERSION = 1;
const WRITE_DEBOUNCE_MS = 300;

const LEGACY_KEYS = {
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
const SIDEBAR_GROUP_BYS = ["status", "repo"] as const;
const DIFF_LAYERS = ["committed", "staged", "unstaged", "untracked"] as const;
const STATUS_GROUP_KEYS = [
  "status:merged",
  "status:in-review",
  "status:draft",
  "status:in-progress",
  "status:closed",
  "status:archived",
] as const;

type RightSidebarTab = (typeof RIGHT_SIDEBAR_TABS)[number];
type SidebarGroupBy = (typeof SIDEBAR_GROUP_BYS)[number];

export interface PersistedViewStateV1 {
  version: 1;
  sidebarVisible: boolean;
  rightSidebarVisible: boolean;
  terminalPanelVisible: boolean;
  sidebarWidth: number;
  rightSidebarWidth: number;
  terminalHeight: number;
  rightSidebarTab: RightSidebarTab;
  sidebarGroupBy: SidebarGroupBy;
  sidebarRepoFilter: string;
  sidebarShowArchived: boolean;
  selectedWorkspaceId: string | null;
  selectedSessionIdByWorkspaceId: Record<string, string>;
  repoCollapsed: Record<string, boolean>;
  statusGroupCollapsed: Record<string, boolean>;
  allFilesExpandedDirsByWorkspace: Record<string, Record<string, boolean>>;
  allFilesSelectedPathByWorkspace: Record<string, string | null>;
  fileTabsByWorkspace: Record<string, string[]>;
  activeFileTabByWorkspace: Record<string, string | null>;
  diffTabsByWorkspace: Record<string, DiffFileTab[]>;
  diffSelectionByWorkspace: Record<string, DiffSelection>;
  tabOrderByWorkspace: Record<string, UnifiedTabEntry[]>;
  activeTerminalTabId: Record<string, number | null>;
  terminalPaneTrees: Record<number, TerminalPaneNode>;
  activeTerminalPaneId: Record<number, string>;
}

type PersistedViewState = PersistedViewStateV1;

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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isObject(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  if (!isObject(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "boolean");
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

function parseRightSidebarTab(value: unknown, fallback: RightSidebarTab): RightSidebarTab {
  return typeof value === "string" && (RIGHT_SIDEBAR_TABS as readonly string[]).includes(value)
    ? (value as RightSidebarTab)
    : fallback;
}

function parseSidebarGroupBy(value: unknown, fallback: SidebarGroupBy): SidebarGroupBy {
  return typeof value === "string" && (SIDEBAR_GROUP_BYS as readonly string[]).includes(value)
    ? (value as SidebarGroupBy)
    : fallback;
}

function parseDiffLayer(value: unknown): DiffLayer | null {
  if (value === null) return null;
  return typeof value === "string" && (DIFF_LAYERS as readonly string[]).includes(value)
    ? (value as DiffLayer)
    : null;
}

function parseDiffTab(value: unknown): DiffFileTab | null {
  if (!isObject(value) || typeof value.path !== "string") return null;
  return { path: value.path, layer: parseDiffLayer(value.layer) };
}

function parseTabOrderEntry(value: unknown): UnifiedTabEntry | null {
  if (!isObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "session" && typeof value.sessionId === "string") {
    return { kind: "session", sessionId: value.sessionId };
  }
  if (value.kind === "diff" && typeof value.path === "string") {
    return { kind: "diff", path: value.path, layer: parseDiffLayer(value.layer) };
  }
  if (value.kind === "file" && typeof value.path === "string") {
    return { kind: "file", path: value.path };
  }
  return null;
}

function parseWorkspaceStringArrayMap(value: unknown): Record<string, string[]> {
  if (!isObject(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [workspaceId, paths] of Object.entries(value)) {
    if (Array.isArray(paths)) {
      out[workspaceId] = paths.filter((path): path is string => typeof path === "string");
    }
  }
  return out;
}

function parseNullableStringMap(value: unknown): Record<string, string | null> {
  if (!isObject(value)) return {};
  const out: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || entry === null) out[key] = entry;
  }
  return out;
}

function parseExpandedDirs(value: unknown): Record<string, Record<string, boolean>> {
  if (!isObject(value)) return {};
  const out: Record<string, Record<string, boolean>> = {};
  for (const [workspaceId, dirs] of Object.entries(value)) {
    if (isBooleanRecord(dirs)) out[workspaceId] = dirs;
  }
  return out;
}

function parseDiffTabsByWorkspace(value: unknown): Record<string, DiffFileTab[]> {
  if (!isObject(value)) return {};
  const out: Record<string, DiffFileTab[]> = {};
  for (const [workspaceId, tabs] of Object.entries(value)) {
    if (!Array.isArray(tabs)) continue;
    out[workspaceId] = tabs.map(parseDiffTab).filter((tab): tab is DiffFileTab => tab !== null);
  }
  return out;
}

function parseDiffSelectionByWorkspace(value: unknown): Record<string, DiffSelection> {
  if (!isObject(value)) return {};
  const out: Record<string, DiffSelection> = {};
  for (const [workspaceId, selection] of Object.entries(value)) {
    const parsed = parseDiffTab(selection);
    if (parsed) out[workspaceId] = parsed;
  }
  return out;
}

function parseTabOrderByWorkspace(value: unknown): Record<string, UnifiedTabEntry[]> {
  if (!isObject(value)) return {};
  const out: Record<string, UnifiedTabEntry[]> = {};
  for (const [workspaceId, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) continue;
    out[workspaceId] = entries
      .map(parseTabOrderEntry)
      .filter((entry): entry is UnifiedTabEntry => entry !== null);
  }
  return out;
}

function parseActiveTerminalTabId(value: unknown): Record<string, number | null> {
  if (!isObject(value)) return {};
  const out: Record<string, number | null> = {};
  for (const [workspaceId, tabId] of Object.entries(value)) {
    if (tabId === null) out[workspaceId] = null;
    else if (typeof tabId === "number" && Number.isInteger(tabId) && tabId > 0) {
      out[workspaceId] = tabId;
    }
  }
  return out;
}

function parseTerminalPaneNode(value: unknown): TerminalPaneNode | null {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "leaf") {
    return { kind: "leaf", id: value.id };
  }
  if (value.kind !== "split") return null;
  if (value.direction !== "horizontal" && value.direction !== "vertical") return null;
  if (!Array.isArray(value.children) || value.children.length !== 2) return null;
  const left = parseTerminalPaneNode(value.children[0]);
  const right = parseTerminalPaneNode(value.children[1]);
  if (!left || !right) return null;
  const sizes =
    Array.isArray(value.sizes) &&
    value.sizes.length === 2 &&
    typeof value.sizes[0] === "number" &&
    typeof value.sizes[1] === "number" &&
    Number.isFinite(value.sizes[0]) &&
    Number.isFinite(value.sizes[1])
      ? [Math.max(5, Math.min(95, value.sizes[0])), Math.max(5, Math.min(95, value.sizes[1]))] as [number, number]
      : [50, 50] as [number, number];
  return {
    kind: "split",
    id: value.id,
    direction: value.direction,
    children: [left, right],
    sizes,
  };
}

function parseTerminalPaneTrees(value: unknown): Record<number, TerminalPaneNode> {
  if (!isObject(value)) return {};
  const out: Record<number, TerminalPaneNode> = {};
  for (const [tabIdRaw, tree] of Object.entries(value)) {
    const tabId = Number(tabIdRaw);
    const parsed = parseTerminalPaneNode(tree);
    if (Number.isInteger(tabId) && tabId > 0 && parsed) out[tabId] = parsed;
  }
  return out;
}

function parsePersistedViewState(raw: string | null): PersistedViewState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.version !== VIEW_STATE_VERSION) return null;

  return {
    version: 1,
    sidebarVisible: typeof parsed.sidebarVisible === "boolean" ? parsed.sidebarVisible : true,
    rightSidebarVisible:
      typeof parsed.rightSidebarVisible === "boolean" ? parsed.rightSidebarVisible : false,
    terminalPanelVisible:
      typeof parsed.terminalPanelVisible === "boolean" ? parsed.terminalPanelVisible : false,
    sidebarWidth: clampNumber(parsed.sidebarWidth, 150, 600, 260),
    rightSidebarWidth: clampNumber(parsed.rightSidebarWidth, 150, 600, 250),
    terminalHeight: clampNumber(parsed.terminalHeight, 100, 800, 300),
    rightSidebarTab: parseRightSidebarTab(parsed.rightSidebarTab, "files"),
    sidebarGroupBy: parseSidebarGroupBy(parsed.sidebarGroupBy, "repo"),
    sidebarRepoFilter: typeof parsed.sidebarRepoFilter === "string" ? parsed.sidebarRepoFilter : "all",
    sidebarShowArchived:
      typeof parsed.sidebarShowArchived === "boolean" ? parsed.sidebarShowArchived : false,
    selectedWorkspaceId:
      typeof parsed.selectedWorkspaceId === "string" || parsed.selectedWorkspaceId === null
        ? parsed.selectedWorkspaceId
        : null,
    selectedSessionIdByWorkspaceId: isStringRecord(parsed.selectedSessionIdByWorkspaceId)
      ? parsed.selectedSessionIdByWorkspaceId
      : {},
    repoCollapsed: isBooleanRecord(parsed.repoCollapsed) ? parsed.repoCollapsed : {},
    statusGroupCollapsed: isBooleanRecord(parsed.statusGroupCollapsed)
      ? parsed.statusGroupCollapsed
      : {},
    allFilesExpandedDirsByWorkspace: parseExpandedDirs(parsed.allFilesExpandedDirsByWorkspace),
    allFilesSelectedPathByWorkspace: parseNullableStringMap(parsed.allFilesSelectedPathByWorkspace),
    fileTabsByWorkspace: parseWorkspaceStringArrayMap(parsed.fileTabsByWorkspace),
    activeFileTabByWorkspace: parseNullableStringMap(parsed.activeFileTabByWorkspace),
    diffTabsByWorkspace: parseDiffTabsByWorkspace(parsed.diffTabsByWorkspace),
    diffSelectionByWorkspace: parseDiffSelectionByWorkspace(parsed.diffSelectionByWorkspace),
    tabOrderByWorkspace: parseTabOrderByWorkspace(parsed.tabOrderByWorkspace),
    activeTerminalTabId: parseActiveTerminalTabId(parsed.activeTerminalTabId),
    terminalPaneTrees: parseTerminalPaneTrees(parsed.terminalPaneTrees),
    activeTerminalPaneId: isStringRecord(parsed.activeTerminalPaneId)
      ? parsed.activeTerminalPaneId
      : {},
  };
}

function leafIds(tree: TerminalPaneNode): string[] {
  if (tree.kind === "leaf") return [tree.id];
  return [...leafIds(tree.children[0]), ...leafIds(tree.children[1])];
}

function sanitizePaneTreeForPersistence(tree: TerminalPaneNode): TerminalPaneNode {
  if (tree.kind === "leaf") {
    return { kind: "leaf", id: tree.id };
  }
  return {
    kind: "split",
    id: tree.id,
    direction: tree.direction,
    children: [
      sanitizePaneTreeForPersistence(tree.children[0]),
      sanitizePaneTreeForPersistence(tree.children[1]),
    ],
    sizes: tree.sizes,
  };
}

function filteredRecord<T>(
  record: Record<string, T>,
  workspaceIds: Set<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([workspaceId]) => workspaceIds.has(workspaceId)),
  );
}

function filteredBooleanRecord(
  record: Record<string, boolean>,
  ids: Set<string>,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(record).filter(([id]) => ids.has(id)),
  );
}

function diffTabKey(tab: DiffFileTab): string {
  return `${tab.path}\0${tab.layer ?? ""}`;
}

function filterTabOrderEntries(
  entries: UnifiedTabEntry[],
  fileTabs: string[],
  diffTabs: DiffFileTab[],
): UnifiedTabEntry[] {
  const fileSet = new Set(fileTabs);
  const diffSet = new Set(diffTabs.map(diffTabKey));
  return entries.filter((entry) => {
    if (entry.kind === "session") return true;
    if (entry.kind === "file") return fileSet.has(entry.path);
    return diffSet.has(diffTabKey(entry));
  });
}

export function buildPersistedViewState(state: AppState): PersistedViewStateV1 {
  const diffSelectionByWorkspace = { ...state.diffSelectionByWorkspace };
  if (state.selectedWorkspaceId && state.diffSelectedFile) {
    diffSelectionByWorkspace[state.selectedWorkspaceId] = {
      path: state.diffSelectedFile,
      layer: state.diffSelectedLayer,
    };
  } else if (state.selectedWorkspaceId) {
    delete diffSelectionByWorkspace[state.selectedWorkspaceId];
  }

  const terminalPaneTrees = Object.fromEntries(
    Object.entries(state.terminalPaneTrees).map(([tabId, tree]) => [
      tabId,
      sanitizePaneTreeForPersistence(tree),
    ]),
  ) as Record<number, TerminalPaneNode>;

  return {
    version: 1,
    sidebarVisible: state.sidebarVisible,
    rightSidebarVisible: state.rightSidebarVisible,
    terminalPanelVisible: state.terminalPanelVisible,
    sidebarWidth: state.sidebarWidth,
    rightSidebarWidth: state.rightSidebarWidth,
    terminalHeight: state.terminalHeight,
    rightSidebarTab: state.rightSidebarTab,
    sidebarGroupBy: state.sidebarGroupBy,
    sidebarRepoFilter: state.sidebarRepoFilter,
    sidebarShowArchived: state.sidebarShowArchived,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionIdByWorkspaceId: state.selectedSessionIdByWorkspaceId,
    repoCollapsed: state.repoCollapsed,
    statusGroupCollapsed: state.statusGroupCollapsed,
    allFilesExpandedDirsByWorkspace: state.allFilesExpandedDirsByWorkspace,
    allFilesSelectedPathByWorkspace: state.allFilesSelectedPathByWorkspace,
    fileTabsByWorkspace: state.fileTabsByWorkspace,
    activeFileTabByWorkspace: state.activeFileTabByWorkspace,
    diffTabsByWorkspace: state.diffTabsByWorkspace,
    diffSelectionByWorkspace,
    tabOrderByWorkspace: state.tabOrderByWorkspace,
    activeTerminalTabId: state.activeTerminalTabId,
    terminalPaneTrees,
    activeTerminalPaneId: state.activeTerminalPaneId,
  };
}

async function loadLegacyPanelState(): Promise<Partial<AppState>> {
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
    getAppSetting(LEGACY_KEYS.sidebarVisible),
    getAppSetting(LEGACY_KEYS.rightSidebarVisible),
    getAppSetting(LEGACY_KEYS.terminalPanelVisible),
    getAppSetting(LEGACY_KEYS.sidebarWidth),
    getAppSetting(LEGACY_KEYS.rightSidebarWidth),
    getAppSetting(LEGACY_KEYS.terminalHeight),
    getAppSetting(LEGACY_KEYS.rightSidebarTab),
    getAppSetting(LEGACY_KEYS.sidebarGroupBy),
    getAppSetting(LEGACY_KEYS.sidebarShowArchived),
  ]);

  const updates: Partial<AppState> = {};
  const sbVisB = parseBool(sbVis);
  if (sbVisB !== null) updates.sidebarVisible = sbVisB;
  const rsbVisB = parseBool(rsbVis);
  if (rsbVisB !== null) updates.rightSidebarVisible = rsbVisB;
  const termVisB = parseBool(termVis);
  if (termVisB !== null) updates.terminalPanelVisible = termVisB;
  const sbWN = parseClampedInt(sbW, 150, 600);
  if (sbWN !== null) updates.sidebarWidth = sbWN;
  const rsbWN = parseClampedInt(rsbW, 150, 600);
  if (rsbWN !== null) updates.rightSidebarWidth = rsbWN;
  const termHN = parseClampedInt(termH, 100, 800);
  if (termHN !== null) updates.terminalHeight = termHN;
  if (rsbTab && (RIGHT_SIDEBAR_TABS as readonly string[]).includes(rsbTab)) {
    updates.rightSidebarTab = rsbTab as RightSidebarTab;
  }
  if (sbGroup && (SIDEBAR_GROUP_BYS as readonly string[]).includes(sbGroup)) {
    updates.sidebarGroupBy = sbGroup as SidebarGroupBy;
  }
  const sbArchB = parseBool(sbArch);
  if (sbArchB !== null) updates.sidebarShowArchived = sbArchB;
  return updates;
}

export function applyPersistedViewState(
  persisted: PersistedViewState,
  workspaces: readonly Workspace[],
) {
  const activeWorkspaceIds = new Set(
    workspaces.filter((workspace) => workspace.status === "Active").map((workspace) => workspace.id),
  );
  const activeRepositoryIds = new Set(
    workspaces
      .filter((workspace) => workspace.status === "Active")
      .map((workspace) => workspace.repository_id),
  );
  const validStatusGroupKeys = new Set<string>(STATUS_GROUP_KEYS);
  const selectedWorkspaceId =
    persisted.selectedWorkspaceId && activeWorkspaceIds.has(persisted.selectedWorkspaceId)
      ? persisted.selectedWorkspaceId
      : null;

  const fileTabsByWorkspace = filteredRecord(persisted.fileTabsByWorkspace, activeWorkspaceIds);
  const activeFileTabByWorkspace: Record<string, string | null> = {};
  for (const [workspaceId, activePath] of Object.entries(
    filteredRecord(persisted.activeFileTabByWorkspace, activeWorkspaceIds),
  )) {
    activeFileTabByWorkspace[workspaceId] =
      activePath && (fileTabsByWorkspace[workspaceId] ?? []).includes(activePath)
        ? activePath
        : null;
  }

  const fileBuffers: AppState["fileBuffers"] = {};
  for (const [workspaceId, paths] of Object.entries(fileTabsByWorkspace)) {
    for (const path of paths) {
      fileBuffers[fileBufferKey(workspaceId, path)] = makeUnloadedBuffer();
    }
  }

  const diffTabsByWorkspace = filteredRecord(persisted.diffTabsByWorkspace, activeWorkspaceIds);
  const diffSelectionByWorkspace: Record<string, DiffSelection> = {};
  for (const [workspaceId, selection] of Object.entries(
    filteredRecord(persisted.diffSelectionByWorkspace, activeWorkspaceIds),
  )) {
    const tabs = diffTabsByWorkspace[workspaceId] ?? [];
    if (tabs.some((tab) => diffTabKey(tab) === diffTabKey(selection))) {
      diffSelectionByWorkspace[workspaceId] = selection;
    }
  }

  const tabOrderByWorkspace: Record<string, UnifiedTabEntry[]> = {};
  for (const [workspaceId, entries] of Object.entries(
    filteredRecord(persisted.tabOrderByWorkspace, activeWorkspaceIds),
  )) {
    tabOrderByWorkspace[workspaceId] = filterTabOrderEntries(
      entries,
      fileTabsByWorkspace[workspaceId] ?? [],
      diffTabsByWorkspace[workspaceId] ?? [],
    );
  }

  const terminalPaneTrees = persisted.terminalPaneTrees;
  const activeTerminalPaneId: Record<number, string> = {};
  for (const [tabIdRaw, leafId] of Object.entries(persisted.activeTerminalPaneId)) {
    const tabId = Number(tabIdRaw);
    const tree = terminalPaneTrees[tabId];
    if (tree && leafIds(tree).includes(leafId)) {
      activeTerminalPaneId[tabId] = leafId;
    }
  }

  const selectedActiveFile =
    selectedWorkspaceId ? activeFileTabByWorkspace[selectedWorkspaceId] ?? null : null;
  const selectedDiff =
    selectedWorkspaceId && !selectedActiveFile
      ? diffSelectionByWorkspace[selectedWorkspaceId] ?? null
      : null;

  useAppStore.setState({
    sidebarVisible: persisted.sidebarVisible,
    rightSidebarVisible: persisted.rightSidebarVisible,
    terminalPanelVisible: persisted.terminalPanelVisible,
    sidebarWidth: persisted.sidebarWidth,
    rightSidebarWidth: persisted.rightSidebarWidth,
    terminalHeight: persisted.terminalHeight,
    rightSidebarTab: persisted.rightSidebarTab,
    sidebarGroupBy: persisted.sidebarGroupBy,
    sidebarRepoFilter:
      persisted.sidebarRepoFilter === "all" || activeRepositoryIds.has(persisted.sidebarRepoFilter)
        ? persisted.sidebarRepoFilter
        : "all",
    sidebarShowArchived: persisted.sidebarShowArchived,
    selectedWorkspaceId,
    selectedSessionIdByWorkspaceId: filteredRecord(
      persisted.selectedSessionIdByWorkspaceId,
      activeWorkspaceIds,
    ),
    repoCollapsed: filteredBooleanRecord(persisted.repoCollapsed, activeRepositoryIds),
    statusGroupCollapsed: filteredBooleanRecord(
      persisted.statusGroupCollapsed,
      validStatusGroupKeys,
    ),
    allFilesExpandedDirsByWorkspace: filteredRecord(
      persisted.allFilesExpandedDirsByWorkspace,
      activeWorkspaceIds,
    ),
    allFilesSelectedPathByWorkspace: filteredRecord(
      persisted.allFilesSelectedPathByWorkspace,
      activeWorkspaceIds,
    ),
    fileTabsByWorkspace,
    activeFileTabByWorkspace,
    fileBuffers,
    diffTabsByWorkspace,
    diffSelectionByWorkspace,
    diffSelectedFile: selectedDiff?.path ?? null,
    diffSelectedLayer: selectedDiff?.layer ?? null,
    diffContent: null,
    diffError: null,
    diffPreviewMode: "diff",
    diffPreviewContent: null,
    diffPreviewLoading: false,
    diffPreviewError: null,
    tabOrderByWorkspace,
    activeTerminalTabId: filteredRecord(persisted.activeTerminalTabId, activeWorkspaceIds),
    terminalPaneTrees,
    activeTerminalPaneId,
  });
}

export async function hydratePersistedViewState(workspaces: readonly Workspace[]) {
  try {
    const parsed = parsePersistedViewState(await getAppSetting(VIEW_STATE_KEY));
    if (parsed) {
      applyPersistedViewState(parsed, workspaces);
      return;
    }

    const legacyUpdates = await loadLegacyPanelState();
    if (Object.keys(legacyUpdates).length > 0) {
      useAppStore.setState(legacyUpdates);
    }
  } catch (err) {
    console.error("[viewState] Failed to hydrate view state:", err);
  }
}

export function useViewTogglePersistence(enabled: boolean) {
  const lastJsonRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let timeout: number | null = null;
    const flush = () => {
      timeout = null;
      const json = JSON.stringify(buildPersistedViewState(useAppStore.getState()));
      if (json === lastJsonRef.current) return;
      lastJsonRef.current = json;
      void setAppSetting(VIEW_STATE_KEY, json).catch((err) => {
        console.error("[viewState] Failed to persist view state:", err);
      });
    };

    const unsubscribe = useAppStore.subscribe(() => {
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = window.setTimeout(flush, WRITE_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [enabled]);
}
