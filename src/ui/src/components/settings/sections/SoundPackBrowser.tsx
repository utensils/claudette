import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

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
import i18n from "../../../i18n";
import styles from "../Settings.module.css";

const REGISTRY_BASE = "https://openpeon.com/packs/";

function packRegistryUrl(name: string): string {
  return `${REGISTRY_BASE}${encodeURIComponent(name)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const KNOWN_LANGUAGE_CODES = new Set([
  "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh",
  "ru", "ar", "nl", "pl", "sv", "tr",
]);

// Names come from the platform's language display names, in the UI language
// the caller passes so a language switch recomputes them.
function languageLabel(code: string, uiLanguage: string): string {
  if (code === "multi") return i18n.t("settings:sound_pack_language_multi");
  if (!KNOWN_LANGUAGE_CODES.has(code)) return code.toUpperCase();
  try {
    return new Intl.DisplayNames([uiLanguage], { type: "language" }).of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

interface Props {
  installed: InstalledSoundPack[];
  onChanged: () => void;
}

export function SoundPackBrowser({ installed, onChanged }: Props) {
  const { t, i18n: i18nInstance } = useTranslation("settings");
  const uiLanguage = i18nInstance.language;
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
    return [...codes].sort((a, b) => languageLabel(a, uiLanguage).localeCompare(languageLabel(b, uiLanguage)));
  }, [registry, uiLanguage]);

  const installedByName = new Map(installed.map((p) => [p.name, p]));
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
    return <div className={styles.placeholder}>{t("sound_pack_loading")}</div>;
  }

  return (
    <div>
      <div className={styles.pluginToolbar}>
        <div className={styles.pluginFormRow}>
          <input
            className={styles.input}
            placeholder={t("sound_pack_search_placeholder")}
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
            <option value="all">{t("sound_pack_all_languages")}</option>
            {languages.map((code) => (
              <option key={code} value={code}>
                {languageLabel(code, uiLanguage)}
              </option>
            ))}
          </select>
        </div>
        <span className={styles.pluginMeta}>
          {t("sound_pack_count", { shown: filtered.length, total: registry.length })}
        </span>
      </div>

      {error && <div className={styles.pluginError}>{error}</div>}

      <div className={styles.packBrowserList}>
        {filtered.length === 0 && (
          <div className={styles.placeholder}>
            {registry.length === 0
              ? t("sound_pack_none_in_registry")
              : t("sound_pack_none_match")}
          </div>
        )}

        {filtered.map((pack) => {
          const isInstalled = installedNames.has(pack.name);
          const installedPack = installedByName.get(pack.name);
          const hasUpdate =
            isInstalled &&
            installedPack?.installed_ref != null &&
            installedPack.installed_ref !== pack.source_ref;
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
                      <span className={styles.pluginBadge}>{t("sound_pack_badge_installed")}</span>
                    )}
                    {hasUpdate && (
                      <span className={styles.pluginBadge}>{t("sound_pack_badge_update")}</span>
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
                      t("sound_pack_sound_count", { count: pack.sound_count }),
                      formatBytes(pack.total_size_bytes),
                      pack.language ? languageLabel(pack.language, uiLanguage) : null,
                      pack.categories.join(", "),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <div className={styles.pluginActions}>
                  {isInstalled ? (
                    <>
                      {hasUpdate && (
                        <button
                          className={styles.iconBtn}
                          disabled={isBusy}
                          onClick={() => handleUpdate(pack)}
                        >
                          {isBusy ? t("sound_pack_updating") : t("sound_pack_update")}
                        </button>
                      )}
                      <button
                        className={styles.iconBtn}
                        disabled={isBusy}
                        onClick={() => handleDelete(pack.name)}
                      >
                        {isBusy ? t("sound_pack_removing") : t("sound_pack_uninstall")}
                      </button>
                    </>
                  ) : (
                    <button
                      className={styles.iconBtn}
                      disabled={isBusy}
                      onClick={() => handleInstall(pack)}
                    >
                      {isBusy ? t("sound_pack_installing") : t("sound_pack_install")}
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
