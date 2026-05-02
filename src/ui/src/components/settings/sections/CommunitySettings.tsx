import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchRegistry,
  flattenRegistry,
  installContribution,
  listInstalled,
  uninstallContribution,
  type BrowseEntry,
  type ContributionKindWire,
  type InstalledContribution,
  type Registry,
} from "../../../services/community";
import { refreshGrammars } from "../../../utils/grammarRegistry";
import styles from "../Settings.module.css";
import own from "./CommunitySettings.module.css";

type Tab = "browse" | "installed";

const KIND_FILTERS: { id: "all" | ContributionKindWire; label: string }[] = [
  { id: "all", label: "All" },
  { id: "theme", label: "Themes" },
  { id: "plugin:scm", label: "SCM" },
  { id: "plugin:env-provider", label: "Env providers" },
  { id: "plugin:language-grammar", label: "Languages" },
];

export function CommunitySettings() {
  const [tab, setTab] = useState<Tab>("browse");
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [installed, setInstalled] = useState<InstalledContribution[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyIdent, setBusyIdent] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<"all" | ContributionKindWire>("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reg, inst] = await Promise.all([
        fetchRegistry(false),
        listInstalled(),
      ]);
      setRegistry(reg);
      setInstalled(inst);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

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
      <h2 className={styles.sectionTitle}>Community</h2>
      <div className={styles.settingDescription}>
        Browse and install community-contributed themes, plugins, and language
        grammars from{" "}
        <a
          href="https://github.com/utensils/claudette-community"
          target="_blank"
          rel="noreferrer"
          className={own.link}
        >
          utensils/claudette-community
        </a>
        . Each install is verified against the published content hash before
        anything lands on disk.
      </div>

      <div className={own.tabRow}>
        <button
          type="button"
          className={tab === "browse" ? own.tabActive : own.tab}
          onClick={() => setTab("browse")}
        >
          Browse
        </button>
        <button
          type="button"
          className={tab === "installed" ? own.tabActive : own.tab}
          onClick={() => setTab("installed")}
        >
          Installed
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
          {loading ? "Refreshing…" : "Refresh"}
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
            {f.label}
          </button>
        ))}
        {registrySha ? (
          <span className={own.regSha}>
            Registry @ <code>{registrySha.slice(0, 7)}</code>
          </span>
        ) : null}
      </div>

      {loading && entries.length === 0 ? (
        <p className={own.subtle}>Loading registry…</p>
      ) : entries.length === 0 ? (
        <p className={own.subtle}>No contributions match this filter.</p>
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
                  <span className={own.meta}>· by {e.author}</span>
                  <span className={own.meta}>· {e.license}</span>
                </div>
                <p className={own.description}>{e.description}</p>
                {e.required_clis && e.required_clis.length > 0 ? (
                  <p className={own.meta}>
                    Requires CLI:{" "}
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
                      <span className={own.installedBadge}>Installed</span>
                      <button
                        type="button"
                        className={own.dangerButton}
                        disabled={isBusy}
                        onClick={() => onUninstall(e.kind, e.ident)}
                      >
                        {isBusy ? "Removing…" : "Uninstall"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={own.primaryButton}
                      disabled={isBusy}
                      onClick={() => onInstall(e.kind, e.ident)}
                    >
                      {isBusy ? "Installing…" : "Install"}
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
  if (installed.length === 0 && !loading) {
    return (
      <p className={own.subtle}>
        Nothing installed yet. Switch to the Browse tab to install themes,
        plugins, or language grammars.
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
              {i.author ? <span className={own.meta}>· by {i.author}</span> : null}
              {i.license ? <span className={own.meta}>· {i.license}</span> : null}
              <span className={own.meta}>· {i.kind}</span>
            </div>
            <p className={own.meta}>
              Installed {formatDate(i.installed_at)} · sha256{" "}
              <code className={own.cli}>{i.sha256.slice(0, 12)}…</code>
            </p>
            <div className={own.actions}>
              <button
                type="button"
                className={own.dangerButton}
                disabled={isBusy}
                onClick={() => onUninstall(i.kind as ContributionKindWire, i.ident)}
              >
                {isBusy ? "Removing…" : "Uninstall"}
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
