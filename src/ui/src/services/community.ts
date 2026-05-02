import { invoke } from "@tauri-apps/api/core";

// Wire shapes mirror the Rust types in src/community/types.rs and the
// Tauri command surface in src-tauri/src/commands/community.rs.

export type ContributionKindWire =
  | "theme"
  | "plugin:scm"
  | "plugin:env-provider"
  | "plugin:language-grammar";

export type ColorScheme = "dark" | "light";

export interface ContributionSourceInTree {
  type: "in-tree";
  path: string;
  sha: string;
  sha256: string;
}

export interface ContributionSourceExternal {
  type: "external";
  git_url: string;
  git_ref: string;
  sha: string;
  sha256: string;
  mirror_path: string;
}

export type ContributionSource =
  | ContributionSourceInTree
  | ContributionSourceExternal;

export interface ThemeEntry {
  id: string;
  name: string;
  description: string;
  color_scheme: ColorScheme;
  accent_preview: string;
  version: string;
  author: string;
  license: string;
  tags?: string[];
  submitted_at: string;
  source: ContributionSource;
}

export interface PluginEntry {
  name: string;
  display_name: string;
  version: string;
  description: string;
  kind: "scm" | "env-provider" | "language-grammar";
  required_clis?: string[];
  remote_patterns?: string[];
  operations?: string[];
  author: string;
  license: string;
  tags?: string[];
  submitted_at: string;
  source: ContributionSource;
}

export interface Registry {
  version: number;
  generated_at: string;
  source: { repo: string; ref: string; sha: string };
  themes: ThemeEntry[];
  plugins: {
    scm: PluginEntry[];
    "env-provider": PluginEntry[];
    "language-grammar": PluginEntry[];
  };
  slash_commands: unknown[];
  mcp_recipes: unknown[];
}

export interface InstalledContribution {
  kind: ContributionKindWire;
  ident: string;
  display_name: string;
  version: string;
  author: string;
  license: string;
  registry_sha: string;
  contribution_sha: string;
  sha256: string;
  installed_at: string;
}

/** Fetch the community registry from claudette-community/main. */
export function fetchRegistry(force = false): Promise<Registry> {
  return invoke("community_registry_fetch", { force });
}

/**
 * Install a contribution by `(kind, ident)`. The backend re-fetches
 * the registry, downloads the codeload tarball at the entry's SHA,
 * verifies the content hash, writes to `~/.claudette/{plugins,themes}/`,
 * and reloads the plugin runtime so the new plugin is usable without
 * an app restart. Theme runtime loading lands in PR 3 of TDD 567.
 */
export function installContribution(
  kind: ContributionKindWire,
  ident: string,
): Promise<InstalledContribution> {
  return invoke("community_install", { kind, ident });
}

/** Remove a community-installed contribution. Idempotent. */
export function uninstallContribution(
  kind: ContributionKindWire,
  ident: string,
): Promise<void> {
  return invoke("community_uninstall", { kind, ident });
}

/** Walk both install roots and return summaries for everything we
 *  installed (i.e. directories with `.install_meta.json`). */
export function listInstalled(): Promise<InstalledContribution[]> {
  return invoke("community_list_installed");
}

export interface PendingReconsent {
  kind: ContributionKindWire;
  ident: string;
  display_name: string;
  granted: string[];
  missing: string[];
}

/** List community plugins whose live manifest declares CLI
 *  capabilities the user hasn't yet approved. While present, those
 *  plugins fail closed at every `host.exec` and the operation
 *  surfaces a "needs re-consent" error. */
export function listPendingReconsent(): Promise<PendingReconsent[]> {
  return invoke("community_pending_reconsent");
}

/** Approve the live manifest's required_clis as the new grant set
 *  for a community plugin. Rewrites `.install_meta.json` and
 *  rehydrates the runtime. The next operation succeeds. */
export function grantCommunityCapabilities(ident: string): Promise<void> {
  return invoke("community_grant_capabilities", { ident });
}

/** Helper: flatten a Registry into a single typed list useful for
 *  rendering a single browse grid filtered by kind. */
export interface BrowseEntry {
  kind: ContributionKindWire;
  ident: string;
  display_name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  /** For themes only — used to render a swatch in the browse list. */
  accent_preview?: string;
  /** For themes only. */
  color_scheme?: ColorScheme;
  /** For plugins only — surfaces the CLI dependency in the row. */
  required_clis?: string[];
  tags: string[];
}

export function flattenRegistry(reg: Registry): BrowseEntry[] {
  const out: BrowseEntry[] = [];
  for (const t of reg.themes) {
    out.push({
      kind: "theme",
      ident: t.id,
      display_name: t.name,
      description: t.description,
      version: t.version,
      author: t.author,
      license: t.license,
      accent_preview: t.accent_preview,
      color_scheme: t.color_scheme,
      tags: t.tags ?? [],
    });
  }
  for (const p of reg.plugins.scm) {
    out.push({
      kind: "plugin:scm",
      ident: p.name,
      display_name: p.display_name,
      description: p.description,
      version: p.version,
      author: p.author,
      license: p.license,
      required_clis: p.required_clis,
      tags: p.tags ?? [],
    });
  }
  for (const p of reg.plugins["env-provider"]) {
    out.push({
      kind: "plugin:env-provider",
      ident: p.name,
      display_name: p.display_name,
      description: p.description,
      version: p.version,
      author: p.author,
      license: p.license,
      required_clis: p.required_clis,
      tags: p.tags ?? [],
    });
  }
  for (const p of reg.plugins["language-grammar"]) {
    out.push({
      kind: "plugin:language-grammar",
      ident: p.name,
      display_name: p.display_name,
      description: p.description,
      version: p.version,
      author: p.author,
      license: p.license,
      required_clis: p.required_clis,
      tags: p.tags ?? [],
    });
  }
  return out;
}
