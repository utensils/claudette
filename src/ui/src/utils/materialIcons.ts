// Material Icon Theme integration. Maps file/folder names to data-URL-encoded
// SVGs from the `material-icon-theme` npm package (the source of the VS Code
// extension of the same name). The manifest declares which icon to use for
// each extension / exact filename / folder name; we resolve through it on
// every lookup.
//
// SVGs are eager-bundled via `import.meta.glob` with `?raw` so each icon is
// inlined as a string at build time, then URL-encoded once per icon into a
// data URL (`data:image/svg+xml;utf8,...`) at module load. Lookups are pure
// table reads after that.

import manifestJson from "material-icon-theme/dist/material-icons.json";

interface IconDefinition {
  iconPath: string;
}

interface ManifestSection {
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  file?: string;
  folder?: string;
  folderExpanded?: string;
}

interface MaterialManifest extends ManifestSection {
  iconDefinitions: Record<string, IconDefinition>;
  light?: ManifestSection;
}

const manifest = manifestJson as unknown as MaterialManifest;

// Eager-load every SVG in the package as a raw string. Vite resolves the
// glob pattern at build time and emits each SVG inline; nothing is fetched
// at runtime.
const SVG_RAW_MODULES = import.meta.glob<string>(
  "/node_modules/material-icon-theme/icons/*.svg",
  { eager: true, query: "?raw", import: "default" },
);

// filename ("typescript.svg") -> data URL. Built once at module load.
const SVG_DATA_URLS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [path, raw] of Object.entries(SVG_RAW_MODULES)) {
    const filename = path.slice(path.lastIndexOf("/") + 1);
    out[filename] = `data:image/svg+xml;utf8,${encodeURIComponent(raw)}`;
  }
  return out;
})();

function dataUrlForIconName(name: string | undefined): string | null {
  if (!name) return null;
  const def = manifest.iconDefinitions[name];
  if (!def) return null;
  const filename = def.iconPath.slice(def.iconPath.lastIndexOf("/") + 1);
  return SVG_DATA_URLS[filename] ?? null;
}

const FALLBACK_FILE_URL = dataUrlForIconName(manifest.file ?? "file") ?? "";
const FALLBACK_FOLDER_URL = dataUrlForIconName(manifest.folder ?? "folder") ?? "";
const FALLBACK_FOLDER_OPEN_URL =
  dataUrlForIconName(manifest.folderExpanded ?? "folder-open") ?? FALLBACK_FOLDER_URL;

/**
 * Resolve the data URL for a file's material icon. Lookup order matches the
 * VS Code extension: exact filename → progressively shorter compound
 * extensions (e.g. `routing.test.ts` → `test.ts` → `ts`) → default file icon.
 * When `light` is true, light-variant overrides take precedence at each step.
 */
export function getMaterialFileIconUrl(filename: string, light: boolean): string {
  const lower = filename.toLowerCase();

  const lightSection = light ? manifest.light : undefined;

  // 1. Exact filename match.
  let iconName: string | undefined =
    lightSection?.fileNames?.[lower] ?? manifest.fileNames?.[lower];

  // 2. Compound extension match: split on `.` and try each suffix from
  //    longest to shortest. Skip the leading segment (which is the basename).
  //    Example: "Component.module.scss" -> ["module.scss", "scss"].
  if (!iconName) {
    const parts = lower.split(".");
    for (let i = 1; i < parts.length; i++) {
      const ext = parts.slice(i).join(".");
      iconName =
        lightSection?.fileExtensions?.[ext] ?? manifest.fileExtensions?.[ext];
      if (iconName) break;
    }
  }

  return dataUrlForIconName(iconName) ?? FALLBACK_FILE_URL;
}

/**
 * Resolve the data URL for a folder's material icon. Lookup uses the
 * folder's basename against `folderNames` / `folderNamesExpanded`, falling
 * back to the generic folder/folder-open icon. Light variants take
 * precedence when available.
 */
export function getMaterialFolderIconUrl(
  folderName: string,
  expanded: boolean,
  light: boolean,
): string {
  const lower = folderName.toLowerCase();
  const lightSection = light ? manifest.light : undefined;

  const fromLight = expanded
    ? lightSection?.folderNamesExpanded?.[lower]
    : lightSection?.folderNames?.[lower];
  const fromDark = expanded
    ? manifest.folderNamesExpanded?.[lower]
    : manifest.folderNames?.[lower];
  const iconName = fromLight ?? fromDark;

  const url = dataUrlForIconName(iconName);
  if (url) return url;
  return expanded ? FALLBACK_FOLDER_OPEN_URL : FALLBACK_FOLDER_URL;
}
