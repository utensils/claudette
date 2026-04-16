import type {
  AvailablePlugin,
  EditablePluginScope,
  InstalledPlugin,
  PluginMarketplace,
  PluginScope,
} from "../../../types/plugins";

export interface InstalledPluginSummary {
  installationCount: number;
  pluginCount: number;
  updatesAvailable: number;
  unknownVersionCount: number;
}

export interface AvailablePluginSummary {
  total: number;
  installed: number;
  discoverable: number;
  updatesAvailable: number;
}

export interface ExternalPluginLink {
  detail: string;
  label: string;
  url: string;
  meta: string | null;
}

export function summarizeInstalledPlugins(
  plugins: InstalledPlugin[],
): InstalledPluginSummary {
  return {
    installationCount: plugins.length,
    pluginCount: new Set(plugins.map((plugin) => plugin.plugin_id)).size,
    updatesAvailable: plugins.filter((plugin) => plugin.update_available).length,
    unknownVersionCount: plugins.filter((plugin) => !plugin.latest_known_version).length,
  };
}

export function summarizeAvailablePlugins(
  plugins: AvailablePlugin[],
): AvailablePluginSummary {
  const installed = plugins.filter((plugin) => plugin.installed).length;
  return {
    total: plugins.length,
    installed,
    discoverable: plugins.length - installed,
    updatesAvailable: plugins.filter((plugin) => plugin.update_available).length,
  };
}

const scopeOrder: Record<PluginScope, number> = {
  managed: 0,
  user: 1,
  project: 2,
  local: 3,
};

export function hasGlobalInstallation(scopes: PluginScope[]): boolean {
  return scopes.includes("managed") || scopes.includes("user");
}

export function primaryInstalledScope(scopes: PluginScope[]): PluginScope | null {
  if (scopes.length === 0) return null;
  return [...scopes].sort((left, right) => scopeOrder[left] - scopeOrder[right])[0] ?? null;
}

export function canInstallAvailablePluginAtScope(
  plugin: AvailablePlugin,
  scope: EditablePluginScope,
): boolean {
  if (hasGlobalInstallation(plugin.installed_scopes)) {
    return false;
  }
  return !plugin.installed_scopes.includes(scope);
}

export function matchesInstalledPlugin(
  plugin: InstalledPlugin,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  return [
    plugin.plugin_id,
    plugin.name,
    plugin.marketplace ?? "",
    plugin.description ?? "",
    plugin.version,
    plugin.latest_known_version ?? "",
  ].some((value) => value.toLowerCase().includes(needle));
}

export function matchesAvailablePlugin(
  plugin: AvailablePlugin,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  return [
    plugin.plugin_id,
    plugin.name,
    plugin.marketplace,
    plugin.description ?? "",
    plugin.category ?? "",
    plugin.homepage ?? "",
    plugin.source_label,
  ].some((value) => value.toLowerCase().includes(needle));
}

export function matchesMarketplace(
  marketplace: PluginMarketplace,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  return [
    marketplace.name,
    marketplace.source_label,
    marketplace.source_kind,
  ].some((value) => value.toLowerCase().includes(needle));
}

export function sortAvailablePlugins(
  plugins: AvailablePlugin[],
): AvailablePlugin[] {
  return [...plugins].sort((left, right) => {
    if (left.update_available !== right.update_available) {
      return left.update_available ? -1 : 1;
    }
    if (left.installed !== right.installed) {
      return left.installed ? 1 : -1;
    }

    const rightInstallCount = right.install_count ?? -1;
    const leftInstallCount = left.install_count ?? -1;
    if (leftInstallCount !== rightInstallCount) {
      return rightInstallCount - leftInstallCount;
    }

    return left.name.localeCompare(right.name)
      || left.marketplace.localeCompare(right.marketplace);
  });
}

export function isInstalledAtScope(
  plugin: AvailablePlugin,
  scope: PluginScope,
): boolean {
  return plugin.installed_scopes.includes(scope);
}

export function formatInstallCount(count: number | null): string | null {
  if (count === null) return null;
  if (count >= 1000) {
    return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k installs`;
  }
  return `${count} installs`;
}

export function availablePluginLinks(
  plugin: AvailablePlugin,
): ExternalPluginLink[] {
  const links: ExternalPluginLink[] = [];
  const seen = new Set<string>();

  const homepage = normalizeExternalReference(plugin.homepage);
  if (homepage) {
    links.push({
      detail: homepage.detail,
      label: "Homepage",
      meta: null,
      url: homepage.url,
    });
    seen.add(homepage.canonical_url);
  }

  const source = normalizeExternalReference(plugin.source_label);
  if (source && !seen.has(source.canonical_url)) {
    links.push({
      detail: source.detail,
      label: "Source",
      meta: source.meta,
      url: source.url,
    });
  }

  return links;
}

export function marketplaceSourceLink(
  marketplace: PluginMarketplace,
): ExternalPluginLink | null {
  const source = normalizeExternalReference(marketplace.source_label);
  if (!source) {
    return null;
  }

  return {
    detail: source.detail,
    label: "Source",
    meta: source.meta,
    url: source.url,
  };
}

function normalizeExternalReference(
  raw: string | null,
): { canonical_url: string; detail: string; url: string; meta: string | null } | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  const pathMatch = trimmed.match(/^(.*?)\s+\((.+)\)$/);
  const base = (pathMatch?.[1] ?? trimmed).trim();
  const meta = pathMatch?.[2]?.trim() ?? null;

  if (/^https?:\/\//i.test(base) || /^mailto:/i.test(base)) {
    return normalizeHttpLikeReference(base, meta);
  }

  const githubPrefixed = base.match(/^github:([^/]+\/[^/]+)$/i)?.[1];
  if (githubPrefixed) {
    return normalizeHttpLikeReference(toGitHubRepoUrl(githubPrefixed), meta);
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(base)) {
    return normalizeHttpLikeReference(toGitHubRepoUrl(base), meta);
  }

  return null;
}

function toGitHubRepoUrl(repo: string): string {
  return `https://github.com/${repo.replace(/\.git$/i, "")}`;
}

function normalizeHttpLikeReference(
  url: string,
  meta: string | null,
): { canonical_url: string; detail: string; url: string; meta: string | null } {
  return {
    canonical_url: canonicalizeExternalUrl(url),
    detail: externalReferenceDetail(url),
    meta,
    url,
  };
}

function canonicalizeExternalUrl(url: string): string {
  if (/^mailto:/i.test(url)) {
    return url.trim().toLowerCase();
  }

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.pathname = parsed.pathname.replace(/\.git$/i, "").replace(/\/+$/, "") || "/";
    if ((parsed.protocol === "https:" && parsed.port === "443")
      || (parsed.protocol === "http:" && parsed.port === "80")) {
      parsed.port = "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  }
}

function externalReferenceDetail(url: string): string {
  if (/^mailto:/i.test(url)) {
    return url.replace(/^mailto:/i, "");
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "");
    const path = parsed.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
    if (host === "github.com" && path && path !== "/") {
      return path.replace(/^\//, "");
    }
    return path && path !== "/" ? `${host}${path}` : host;
  } catch {
    return url;
  }
}
