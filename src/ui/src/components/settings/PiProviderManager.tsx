// Stateful wrapper that owns:
//   - Fetching the curated provider list from the Pi sidecar
//   - Routing "Configure" actions to the right dialog (API-key entry
//     vs. OAuth device-code modal)
//   - Re-fetching after a successful configure/clear so the list
//     reflects new state
//
// Drop this into the Pi card body (Settings → Models) and into the
// `/login` picker modal. The component takes a single optional
// `onConfigured` callback so callers can extend the post-success
// behavior (e.g. `/login` refreshes Pi models and resumes the chat).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  piClearProviderApiKey,
  piListProviders,
  type PiProvider,
  type PiProviderList,
} from "../../services/tauri/piProviders";
import { PiOAuthModal } from "./PiOAuthModal";
import { PiProviderConfigureDialog } from "./PiProviderConfigureDialog";
import { PiProviderList as PiProviderListView } from "./PiProviderList";
import sharedModal from "../modals/shared.module.css";

export interface PiProviderManagerProps {
  /** Workspace cwd to pass into the harness control session. Not
   *  load-bearing for `list_providers` itself (Pi's auth lives in
   *  ~/.pi), but harness spawning still wants a real path. Pass the
   *  empty string when invoked outside a workspace (e.g. the global
   *  Pi card in Settings); the Tauri layer falls back to `/`. */
  workingDir: string;
  /** Optional hook fired after every successful configure/clear, so
   *  the parent can refresh the Pi card's discovered_models list and
   *  any other dependent UI. */
  onConfigured?: () => void;
}

export function PiProviderManager({
  workingDir,
  onConfigured,
}: PiProviderManagerProps) {
  const { t } = useTranslation("settings");
  const [data, setData] = useState<PiProviderList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "api_key"; provider: PiProvider }
    | { kind: "oauth"; provider: PiProvider }
    | null
  >(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await piListProviders(workingDir);
      setData(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [workingDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleConfigure = (provider: PiProvider) => {
    if (provider.kind === "oauth" || provider.kind === "oauth+enterprise") {
      setDialog({ kind: "oauth", provider });
      return;
    }
    if (provider.kind === "api_key") {
      setDialog({ kind: "api_key", provider });
      return;
    }
    // env_only — handled by the row (opens docs URL); shouldn't land here.
  };

  const handleClear = async (provider: PiProvider) => {
    if (provider.kind === "oauth" || provider.kind === "oauth+enterprise") {
      // OAuth tokens live in Pi's auth.json under the provider id; we
      // can clear them straight from the same shared-scope path used
      // by API-key providers. No API-key dialog needed — its
      // "Replace this key" copy would be nonsense for an OAuth
      // credential. Surface any failure via the existing error path
      // so the user knows whether their token actually got wiped.
      setError(null);
      try {
        await piClearProviderApiKey({
          workingDir,
          providerId: provider.id,
          scope: "shared",
        });
        await refresh();
        onConfigured?.();
      } catch (e) {
        setError(String(e));
      }
      return;
    }
    // For API-key providers reuse the dialog's clear-both-scopes path
    // so the user can also surface partial-failure errors visually.
    setDialog({ kind: "api_key", provider });
  };

  const handleSaved = async () => {
    setDialog(null);
    await refresh();
    onConfigured?.();
  };

  return (
    <>
      {error && <p className={sharedModal.error}>{error}</p>}
      {!data && loading && (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {t("pi_providers_loading", "Loading providers…")}
        </p>
      )}
      {data && (
        <PiProviderListView
          providers={data.providers}
          defaultVisibleCount={data.defaultVisibleCount}
          busy={loading}
          onConfigure={handleConfigure}
          onClear={handleClear}
        />
      )}

      {dialog?.kind === "api_key" && (
        <PiProviderConfigureDialog
          provider={dialog.provider}
          workingDir={workingDir}
          onClose={() => setDialog(null)}
          onSaved={handleSaved}
        />
      )}
      {dialog?.kind === "oauth" && (
        <PiOAuthModal
          provider={dialog.provider}
          workingDir={workingDir}
          onClose={() => setDialog(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
