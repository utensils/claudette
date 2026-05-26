// Provider list rendered inside the Settings → Models → Pi card and
// inside the `/login` provider picker modal. The list itself is pure
// presentation; the configure-action wiring (open the right dialog
// for `kind`) lives in the parent so `/login` can swap in its own
// after-success callback (resume the chat) without duplicating the
// list logic.
//
// Kept deliberately small — no fetch, no state machine. The parent
// owns `loading` / `error` and the curated list, refreshes after a
// configure round-trip, and decides whether to show the disclosure.

import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { openUrl } from "../../services/tauri";
import type { PiProvider } from "../../services/tauri/piProviders";
import styles from "./PiProviderList.module.css";

export interface PiProviderListProps {
  providers: PiProvider[];
  defaultVisibleCount: number;
  /** Disabled while a request is in flight (configure or refresh). */
  busy?: boolean;
  /** Configure the API key or launch OAuth. The handler dispatches on
   *  `provider.kind`. */
  onConfigure: (provider: PiProvider) => void;
  /** Optional: show a "Clear" button on configured rows. Defaults to
   *  enabled. The `/login` picker can disable it to keep that flow
   *  one-shot. */
  onClear?: (provider: PiProvider) => void;
  /** Optional: text to render under the list (count summary etc.). */
  footer?: React.ReactNode;
}

export function PiProviderList({
  providers,
  defaultVisibleCount,
  busy,
  onConfigure,
  onClear,
  footer,
}: PiProviderListProps) {
  const { t } = useTranslation("settings");
  const [showAll, setShowAll] = useState(false);

  const visible = useMemo(() => {
    if (showAll) return providers;
    return providers.slice(0, defaultVisibleCount);
  }, [providers, defaultVisibleCount, showAll]);

  const hiddenCount = providers.length - visible.length;
  const configuredCount = providers.filter((p) => p.configured).length;
  // Sum models only for providers that are actually configured —
  // otherwise the "models available" summary wildly overcounts (Pi
  // ships ~275 OpenRouter models in its registry, but with no key
  // configured the user gets zero of them from getAvailable()).
  const totalModels = providers.reduce(
    (acc, p) => (p.configured ? acc + p.modelCount : acc),
    0,
  );

  if (providers.length === 0) {
    return (
      <div className={styles.empty}>
        {t(
          "pi_providers_empty",
          "Pi reported no providers. Refresh, or check that the sidecar is healthy.",
        )}
      </div>
    );
  }

  return (
    <>
      <div className={styles.summary}>
        <span>
          {t("pi_providers_summary", {
            configured: configuredCount,
            total: providers.length,
            models: totalModels,
            defaultValue:
              "{{configured}}/{{total}} configured · {{models}} models available",
          })}
        </span>
      </div>
      <div className={styles.list}>
        {visible.map((provider) => (
          <PiProviderRow
            key={provider.id}
            provider={provider}
            busy={busy}
            onConfigure={onConfigure}
            onClear={onClear}
          />
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          className={styles.disclosure}
          onClick={() => setShowAll(true)}
        >
          <ChevronRight size={12} aria-hidden />
          {t("pi_providers_show_more", {
            count: hiddenCount,
            defaultValue: "More providers ({{count}})",
          })}
        </button>
      )}
      {showAll && hiddenCount === 0 && providers.length > defaultVisibleCount && (
        <button
          type="button"
          className={styles.disclosure}
          onClick={() => setShowAll(false)}
        >
          <ChevronDown size={12} aria-hidden />
          {t("pi_providers_show_less", "Show fewer providers")}
        </button>
      )}
      {footer}
    </>
  );
}

interface PiProviderRowProps {
  provider: PiProvider;
  busy?: boolean;
  onConfigure: (provider: PiProvider) => void;
  onClear?: (provider: PiProvider) => void;
}

function PiProviderRow({
  provider,
  busy,
  onConfigure,
  onClear,
}: PiProviderRowProps) {
  const { t } = useTranslation("settings");

  const isEnvOnly = provider.kind === "env_only";
  const statusDotClass = [
    styles.statusDot,
    provider.configured && styles.statusDotConfigured,
    !provider.configured && isEnvOnly && styles.statusDotEnvOnly,
  ]
    .filter(Boolean)
    .join(" ");

  // Action button label depends on kind + state. OAuth providers say
  // "Sign in" / "Reauthenticate" (the *primary* button stays a sign-
  // in entry point even when configured — sign-out routes through
  // the separate Clear button below). env_only providers point at
  // docs. API-key providers say Configure / Reconfigure.
  const actionLabel = (() => {
    if (isEnvOnly) {
      return t("pi_provider_view_docs", "Docs");
    }
    if (provider.kind.startsWith("oauth")) {
      return provider.configured
        ? t("pi_provider_reauthenticate", "Reauthenticate")
        : t("pi_provider_signin", "Sign in");
    }
    return provider.configured
      ? t("pi_provider_reconfigure", "Reconfigure")
      : t("pi_provider_configure", "Configure");
  })();

  // Clear button is only meaningful for credentials we own — keychain
  // entries we wrote (auth_source ∈ {stored, fallback after our
  // save}) plus the catch-all of "no source recorded but the user
  // just configured it". env/models_json sources represent state Pi
  // discovered from the shell or models.json that Claudette cannot
  // delete, so the button would be a confusing no-op.
  const clearableAuthSource = !provider.authSource
    || provider.authSource === "stored"
    || provider.authSource === "runtime";
  const showClearButton =
    provider.configured && !isEnvOnly && clearableAuthSource && Boolean(onClear);

  // OAuth providers get an explicit Sign-out button in addition to
  // the Reauthenticate primary — the clear-button label changes to
  // "Sign out" so users have a way back without the UI pretending
  // every flow is an API-key dialog.
  const clearLabel = provider.kind.startsWith("oauth")
    ? t("pi_provider_signout", "Sign out")
    : t("pi_provider_clear", "Clear");

  // Show the auth source label for already-configured providers so a
  // user with both an env var and an auth.json entry can tell which
  // one Pi will use. For unconfigured rows we render the env hint as
  // a dashed pill so the affordance is visually distinct from a live
  // source label.
  const sourceLabel = (() => {
    if (!provider.configured) {
      if (provider.envHint) {
        return {
          text: `$${provider.envHint}`,
          isHint: true,
        };
      }
      return undefined;
    }
    switch (provider.authSource) {
      case "stored":
        return { text: t("pi_provider_source_stored_short", "auth.json"), isHint: false };
      case "environment":
        return {
          text: `$${provider.envHint ?? "env"}`,
          isHint: false,
        };
      case "runtime":
        return { text: t("pi_provider_source_runtime_short", "--api-key"), isHint: false };
      case "fallback":
      case "models_json_key":
      case "models_json_command":
        return { text: t("pi_provider_source_models_json_short", "models.json"), isHint: false };
      default:
        return undefined;
    }
  })();

  return (
    <div className={styles.row}>
      <span className={statusDotClass} aria-hidden />
      <div className={styles.body}>
        <div className={styles.headerLine}>
          <span className={styles.label}>{provider.label}</span>
          {provider.modelCount > 0 && (
            <span className={styles.modelCount}>
              {t("pi_provider_model_count", {
                count: provider.modelCount,
                defaultValue: "{{count}} models",
              })}
            </span>
          )}
          <span className={styles.spacer} />
          {sourceLabel && (
            <span
              className={
                sourceLabel.isHint
                  ? `${styles.sourcePill} ${styles.sourcePillEnvHint}`
                  : styles.sourcePill
              }
            >
              {sourceLabel.text}
            </span>
          )}
          <div className={styles.actions}>
            {showClearButton && (
              <button
                type="button"
                className={styles.btn}
                onClick={() => onClear?.(provider)}
                disabled={busy}
              >
                {clearLabel}
              </button>
            )}
            <button
              type="button"
              className={
                provider.configured && !isEnvOnly ? styles.btn : styles.btnPrimary
              }
              onClick={() => {
                if (isEnvOnly && provider.docsUrl) {
                  // Tauri's webview blocks bare `window.open`; route
                  // every external-link launch through the
                  // `open_url` command the rest of Settings uses.
                  void openUrl(provider.docsUrl).catch(() => {});
                  return;
                }
                onConfigure(provider);
              }}
              disabled={busy}
            >
              {isEnvOnly && (
                <ExternalLink size={11} aria-hidden style={{ marginRight: 4 }} />
              )}
              {actionLabel}
            </button>
          </div>
        </div>
        <span className={styles.description}>{provider.description}</span>
      </div>
    </div>
  );
}
