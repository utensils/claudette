import { useEffect, useMemo, useState } from "react";

import {
  cespFetchRegistry,
  cespInstallPack,
  cespUpdatePack,
  cespDeletePack,
  openUrl,
} from "../../../services/tauri";
import type {
  RegistryPack,
  InstalledSoundPack,
} from "../../../types/soundpacks";
import styles from "../Settings.module.css";

const REGISTRY_BASE = "https://peonping.github.io/registry/packs/";

function packRegistryUrl(name: string): string {
  return `${REGISTRY_BASE}${encodeURIComponent(name)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  ru: "Russian",
  ar: "Arabic",
  nl: "Dutch",
  pl: "Polish",
  sv: "Swedish",
  tr: "Turkish",
  multi: "Multilingual",
};

function languageLabel(code: string): string {
  return LANGUAGE_LABELS[code] ?? code.toUpperCase();
}

interface Props {
  installed: InstalledSoundPack[];
  onChanged: () => void;
}

export function SoundPackBrowser({ installed, onChanged }: Props) {
  const [registry, setRegistry] = useState<RegistryPack[]>([]);
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    cespFetchRegistry()
      .then(setRegistry)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const languages = useMemo(() => {
    const codes = new Set<string>();
    for (const p of registry) {
      if (p.language) codes.add(p.language);
    }
    return [...codes].sort((a, b) => languageLabel(a).localeCompare(languageLabel(b)));
  }, [registry]);

  const installedNames = new Set(installed.map((p) => p.name));

  const filtered = useMemo(() => {
    return registry.filter((p) => {
      if (language !== "all" && p.language !== language) return false;
      const q = search.toLowerCase();
      return (
        !q ||
        p.display_name.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false) ||
        p.categories.some((c) => c.toLowerCase().includes(q))
      );
    });
  }, [registry, search, language]);

  const handleInstall = async (pack: RegistryPack) => {
    setBusy(pack.name);
    setError(null);
    try {
      await cespInstallPack(
        pack.name,
        pack.source_repo,
        pack.source_ref,
        pack.source_path,
      );
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleUpdate = async (pack: RegistryPack) => {
    setBusy(pack.name);
    setError(null);
    try {
      await cespUpdatePack(
        pack.name,
        pack.source_repo,
        pack.source_ref,
        pack.source_path,
      );
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      await cespDeletePack(name);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className={styles.placeholder}>Loading sound pack registry…</div>;
  }

  return (
    <div>
      <div className={styles.pluginToolbar}>
        <div className={styles.pluginFormRow}>
          <input
            className={styles.input}
            placeholder="Search packs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <select
            className={styles.select}
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="all">All languages</option>
            {languages.map((code) => (
              <option key={code} value={code}>
                {languageLabel(code)}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.pluginMeta}>
          {filtered.length} of {registry.length} packs
        </span>
      </div>

      {error && <div className={styles.pluginError}>{error}</div>}

      <div className={styles.packBrowserList}>
        {filtered.length === 0 && (
          <div className={styles.placeholder}>
            {registry.length === 0
              ? "No packs available in the registry."
              : "No packs match your filters."}
          </div>
        )}

        {filtered.map((pack) => {
          const isInstalled = installedNames.has(pack.name);
          const installedPack = installed.find((p) => p.name === pack.name);
          const isBusy = busy === pack.name;

          return (
            <div key={pack.name} className={styles.pluginCard}>
              <div className={styles.pluginCardHeader}>
                <div className={styles.pluginCardBody}>
                  <div className={styles.pluginCardTitle}>
                    <a
                      className={styles.packNameLink}
                      href={packRegistryUrl(pack.name)}
                      onClick={(e) => {
                        e.preventDefault();
                        void openUrl(packRegistryUrl(pack.name));
                      }}
                    >
                      {pack.display_name}
                    </a>
                    {isInstalled && (
                      <span className={styles.pluginBadge}>installed</span>
                    )}
                    {installedPack?.update_available && (
                      <span className={styles.pluginBadge}>update</span>
                    )}
                    <span className={styles.pluginBadge}>
                      {pack.source_ref}
                    </span>
                  </div>
                  {pack.description && (
                    <div className={styles.settingDescription}>
                      {pack.description}
                    </div>
                  )}
                  <div className={styles.pluginMeta}>
                    {[
                      `${pack.sound_count} sounds`,
                      formatBytes(pack.total_size_bytes),
                      pack.language ? languageLabel(pack.language) : null,
                      pack.categories.join(", "),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <div className={styles.pluginActions}>
                  {isInstalled ? (
                    <>
                      {installedPack?.update_available && (
                        <button
                          className={styles.iconBtn}
                          disabled={isBusy}
                          onClick={() => handleUpdate(pack)}
                        >
                          {isBusy ? "Updating…" : "Update"}
                        </button>
                      )}
                      <button
                        className={styles.iconBtn}
                        disabled={isBusy}
                        onClick={() => handleDelete(pack.name)}
                      >
                        {isBusy ? "Removing…" : "Uninstall"}
                      </button>
                    </>
                  ) : (
                    <button
                      className={styles.iconBtn}
                      disabled={isBusy}
                      onClick={() => handleInstall(pack)}
                    >
                      {isBusy ? "Installing…" : "Install"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
