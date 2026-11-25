import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  fetchRegistry,
  flattenRegistry,
  grantCommunityCapabilities,
  installContribution,
  listInstalled,
  listPendingReconsent,
  uninstallContribution,
  type BrowseEntry,
  type ContributionKindWire,
  type InstalledContribution,
  type PendingReconsent,
  type Registry,
} from "../../../services/community";
import { refreshGrammars } from "../../../utils/grammarRegistry";
import { openUrl } from "../../../services/tauri";
import styles from "../Settings.module.css";
import { Trans, useTranslation } from "react-i18next";
import own from "./CommunitySettings.module.css";

/// Tauri's webview blocks raw <a href> navigation to external origins.
/// Intercept the click and round-trip through the `open_url` Tauri
/// command, which opens the link in the user's default browser. Same
/// pattern other settings sections (ClaudeCodePluginsSettings) use.
function handleExternalLink(href: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    void openUrl(href).catch((err) =>
      console.warn("openUrl failed:", err),
    );
  };
}

type Tab = "browse" | "installed";

const KIND_FILTERS: {
  id: "all" | ContributionKindWire;
  labelKey:
    | "community_filter_all"
    | "community_filter_themes"
    | "community_filter_scm"
    | "community_filter_env_providers"
    | "community_filter_languages";
}[] = [
  { id: "all", labelKey: "community_filter_all" },
  { id: "theme", labelKey: "community_filter_themes" },
  { id: "plugin:scm", labelKey: "community_filter_scm" },
  { id: "plugin:env-provider", labelKey: "community_filter_env_providers" },
  { id: "plugin:language-grammar", labelKey: "community_filter_languages" },
];

export function CommunitySettings() {
  const { t } = useTranslation("settings");
  const [tab, setTab] = useState<Tab>("browse");
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [installed, setInstalled] = useState<InstalledContribution[] | null>(null);
  const [pendingReconsent, setPendingReconsent] = useState<PendingReconsent[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIdent, setBusyIdent] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<"all" | ContributionKindWire>("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reg, inst, pending] = await Promise.all([
        fetchRegistry(false),
        listInstalled(),
        listPendingReconsent(),
      ]);
      setRegistry(reg);
      setInstalled(inst);
      setPendingReconsent(pending);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleApproveReconsent = useCallback(
    async (ident: string) => {
      setBusyIdent(`reconsent:${ident}`);
      setError(null);
      try {
        await grantCommunityCapabilities(ident);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyIdent(null);
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installedKey = useMemo(
    () => new Set((installed ?? []).map((i) => `${i.kind}:${i.ident}`)),
    [installed],
  );

  const browseEntries = useMemo<BrowseEntry[]>(() => {
    if (!registry) return [];
    const all = flattenRegistry(registry);
    if (filterKind === "all") return all;
    return all.filter((e) => e.kind === filterKind);
  }, [registry, filterKind]);

  const handleInstall = useCallback(
    async (kind: ContributionKindWire, ident: string) => {
      setBusyIdent(`${kind}:${ident}`);
      setError(null);
      try {
        await installContribution(kind, ident);
        await refresh();
        // Hot-reload the grammar registry if the install was a
        // language-grammar plugin (issue 570) — without this the new
        // language wouldn't render until app restart.
        if (kind === "plugin:language-grammar") {
          await refreshGrammars();
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyIdent(null);
      }
    },
    [refresh],
  );

  const handleUninstall = useCallback(
    async (kind: ContributionKindWire, ident: string) => {
      setBusyIdent(`${kind}:${ident}`);
      setError(null);
      try {
        await uninstallContribution(kind, ident);
        await refresh();
        if (kind === "plugin:language-grammar") {
          await refreshGrammars();
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyIdent(null);
      }
    },
    [refresh],
  );

  return (
    <div className={own.section}>
      <h2 className={styles.sectionTitle}>{t("nav_community")}</h2>
      <div className={styles.settingDescription}>
        <Trans
          i18nKey="community_description"
          ns="settings"
          components={{
            repo: (
              <a
                href="https://github.com/utensils/claudette-community"
                target="_blank"
                rel="noreferrer"
                className={own.link}
                onClick={handleExternalLink(
                  "https://github.com/utensils/claudette-community",
                )}
              />
            ),
          }}
        />
      </div>

      {pendingReconsent.length > 0 && (
        <ul className={own.list}>
          {pendingReconsent.map((p) => {
            const isBusy = busyIdent === `reconsent:${p.ident}`;
            return (
              <li key={p.ident} className={own.row}>
                <div className={own.rowHeader}>
                  <strong>{p.display_name}</strong>
                  <span className={own.meta}>{t("community_needs_reconsent")}</span>
                </div>
                <p className={own.description}>
                  {t("community_reconsent_description")}
                </p>
                <p className={own.meta}>
                  {t("community_already_approved")}{" "}
                  {p.granted.length === 0 ? (
                    <em>{t("community_none")}</em>
                  ) : (
                    p.granted.map((c) => (
                      <code key={c} className={own.cli}>
                        {c}
                      </code>
                    ))
                  )}
                </p>
                <p className={own.meta}>
                  {t("community_new_capabilities")}{" "}
                  {p.missing.map((c) => (
                    <code key={c} className={own.cli}>
                      {c}
                    </code>
                  ))}
                </p>
                <div className={own.actions}>
                  <button
                    type="button"
                    className={own.primaryButton}
                    disabled={isBusy}
                    onClick={() => handleApproveReconsent(p.ident)}
                  >
                    {isBusy ? t("community_approving") : t("community_approve")}
                  </button>
                  <button
                    type="button"
                    className={own.dangerButton}
                    disabled={isBusy}
                    onClick={() => handleUninstall(p.kind, p.ident)}
                  >
                    {t("community_uninstall")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className={own.tabRow}>
        <button
          type="button"
          className={tab === "browse" ? own.tabActive : own.tab}
          onClick={() => setTab("browse")}
        >
          {t("community_tab_browse")}
        </button>
        <button
          type="button"
          className={tab === "installed" ? own.tabActive : own.tab}
          onClick={() => setTab("installed")}
        >
          {t("community_installed")}
          {installed && installed.length > 0 ? (
            <span className={own.badge}>{installed.length}</span>
          ) : null}
        </button>
        <span className={own.spacer} />
        <button
          type="button"
          className={own.refreshButton}
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? t("community_refreshing") : t("community_refresh")}
        </button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {tab === "browse" ? (
        <BrowseTab
          entries={browseEntries}
          installedKey={installedKey}
          loading={loading}
          busyIdent={busyIdent}
          filterKind={filterKind}
          onFilterChange={setFilterKind}
          onInstall={handleInstall}
          onUninstall={handleUninstall}
          registrySha={registry?.source.sha}
        />
      ) : (
        <InstalledTab
          installed={installed ?? []}
          loading={loading}
          busyIdent={busyIdent}
          onUninstall={handleUninstall}
        />
      )}
    </div>
  );
}

interface BrowseTabProps {
  entries: BrowseEntry[];
  installedKey: Set<string>;
  loading: boolean;
  busyIdent: string | null;
  filterKind: "all" | ContributionKindWire;
  onFilterChange: (k: "all" | ContributionKindWire) => void;
  onInstall: (kind: ContributionKindWire, ident: string) => void;
  onUninstall: (kind: ContributionKindWire, ident: string) => void;
  registrySha?: string;
}

function BrowseTab({
  entries,
  installedKey,
  loading,
  busyIdent,
  filterKind,
  onFilterChange,
  onInstall,
  onUninstall,
  registrySha,
}: BrowseTabProps) {
  const { t } = useTranslation("settings");
  return (
    <>
      <div className={own.filterRow}>
        {KIND_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={filterKind === f.id ? own.filterActive : own.filter}
            onClick={() => onFilterChange(f.id)}
          >
            {t(f.labelKey)}
          </button>
        ))}
        {registrySha ? (
          <span className={own.regSha}>
            {t("community_registry_at")} <code>{registrySha.slice(0, 7)}</code>
          </span>
        ) : null}
      </div>

      {loading && entries.length === 0 ? (
        <p className={own.subtle}>{t("community_loading_registry")}</p>
      ) : entries.length === 0 ? (
        <p className={own.subtle}>{t("community_no_match")}</p>
      ) : (
        <ul className={own.list}>
          {entries.map((e) => {
            const key = `${e.kind}:${e.ident}`;
            const isInstalled = installedKey.has(key);
            const isBusy = busyIdent === key;
            return (
              <li key={key} className={own.row}>
                <div className={own.rowHeader}>
                  {e.kind === "theme" && isSafeHexColor(e.accent_preview) ? (
                    <span
                      className={own.swatch}
                      style={{ backgroundColor: e.accent_preview }}
                      aria-hidden
                    />
                  ) : null}
                  <strong>{e.display_name}</strong>
                  <span className={own.meta}>v{e.version}</span>
                  <span className={own.meta}>· {t("community_by_author", { author: e.author })}</span>
                  <span className={own.meta}>· {e.license}</span>
                </div>
                <p className={own.description}>{e.description}</p>
                {e.required_clis && e.required_clis.length > 0 ? (
                  <p className={own.meta}>
                    {t("community_requires_cli")}{" "}
                    {e.required_clis.map((c) => (
                      <code key={c} className={own.cli}>
                        {c}
                      </code>
                    ))}
                  </p>
                ) : null}
                <div className={own.actions}>
                  {isInstalled ? (
                    <>
                      <span className={own.installedBadge}>{t("community_installed_badge")}</span>
                      <button
                        type="button"
                        className={own.dangerButton}
                        disabled={isBusy}
                        onClick={() => onUninstall(e.kind, e.ident)}
                      >
                        {isBusy ? t("community_removing") : t("community_uninstall")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={own.primaryButton}
                      disabled={isBusy}
                      onClick={() => onInstall(e.kind, e.ident)}
                    >
                      {isBusy ? t("community_installing") : t("community_install")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

interface InstalledTabProps {
  installed: InstalledContribution[];
  loading: boolean;
  busyIdent: string | null;
  onUninstall: (kind: ContributionKindWire, ident: string) => void;
}

function InstalledTab({
  installed,
  loading,
  busyIdent,
  onUninstall,
}: InstalledTabProps) {
  const { t } = useTranslation("settings");
  if (installed.length === 0 && !loading) {
    return (
      <p className={own.subtle}>
        {t("community_nothing_installed")}
      </p>
    );
  }
  return (
    <ul className={own.list}>
      {installed.map((i) => {
        const key = `${i.kind}:${i.ident}`;
        const isBusy = busyIdent === key;
        return (
          <li key={key} className={own.row}>
            <div className={own.rowHeader}>
              <strong>{i.display_name}</strong>
              <span className={own.meta}>v{i.version}</span>
              {i.author ? <span className={own.meta}>· {t("community_by_author", { author: i.author })}</span> : null}
              {i.license ? <span className={own.meta}>· {i.license}</span> : null}
              <span className={own.meta}>· {i.kind}</span>
            </div>
            <p className={own.meta}>
              <Trans
                i18nKey="community_installed_meta"
                ns="settings"
                values={{ date: formatDate(i.installed_at), hash: i.sha256.slice(0, 12) }}
                components={{ code: <code className={own.cli} /> }}
              />
            </p>
            <div className={own.actions}>
              <button
                type="button"
                className={own.dangerButton}
                disabled={isBusy}
                onClick={() => onUninstall(i.kind as ContributionKindWire, i.ident)}
              >
                {isBusy ? t("community_removing") : t("community_uninstall")}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/// Defense in depth on registry-supplied color values: `accent_preview`
/// is plumbed into an inline style, and CSS color properties accept
/// far more than a `#rrggbb` literal (`url(...)`, `var(...)`, …). We
/// validate the registry value against a strict 6/8-char hex pattern
/// before letting it influence rendering. The registry's own JSON
/// schema also enforces this on input, but a malformed entry from a
/// future registry must fail closed in the UI.
function isSafeHexColor(value: string | undefined): value is string {
  return !!value && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value);
}
