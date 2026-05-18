// OAuth device-code modal for Pi providers (kind === "oauth" |
// "oauth+enterprise"). Drives the harness's `oauth_start` flow:
//
// 1. Subscribe to `pi://oauth/event` BEFORE issuing `pi_oauth_start`
//    (the first event can race past a late subscriber).
// 2. Render the verification URL + user code from `oauth_challenge {
//    kind: "auth" }` events.
// 3. For `kind: "prompt"` events (Pi's GHES enterprise domain prompt),
//    show a text input and forward the value back via
//    `pi_oauth_submit_input`.
// 4. Close on `oauth_complete`; on cancel send `pi_oauth_cancel`.

import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Modal } from "../modals/Modal";
import shared from "../modals/shared.module.css";
import { openUrl } from "../../services/tauri";
import {
  listenPiOAuthEvents,
  piOAuthCancel,
  piOAuthStart,
  piOAuthSubmitInput,
  type PiOAuthEvent,
  type PiProvider,
} from "../../services/tauri/piProviders";

type Phase =
  | { kind: "starting" }
  | { kind: "auth"; url: string; instructions?: string }
  | {
      kind: "prompt";
      message: string;
      placeholder?: string;
      allowEmpty: boolean;
    }
  | { kind: "progress"; message: string }
  | { kind: "complete"; ok: boolean; error?: string };

export interface PiOAuthModalProps {
  provider: PiProvider;
  workingDir: string;
  onClose: () => void;
  onSaved: () => void;
}

export function PiOAuthModal({
  provider,
  workingDir,
  onClose,
  onSaved,
}: PiOAuthModalProps) {
  const { t } = useTranslation("settings");
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [promptValue, setPromptValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const challengeIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let challengeId: string | null = null;

    const start = async () => {
      try {
        // Subscribe FIRST. The harness emits the first challenge as
        // soon as Pi resolves the device-code, which races past a
        // post-`pi_oauth_start` subscription on a fast network.
        const unlisten = await listenPiOAuthEvents((event) => {
          if (cancelled) return;
          if (
            challengeIdRef.current &&
            event.challengeId !== challengeIdRef.current
          ) {
            return;
          }
          handleEvent(event);
        });
        unlistenRef.current = unlisten;

        const started = await piOAuthStart({
          workingDir,
          providerId: provider.id,
        });
        if (cancelled) {
          await piOAuthCancel(started.challengeId).catch(() => {});
          return;
        }
        challengeId = started.challengeId;
        challengeIdRef.current = started.challengeId;
      } catch (e) {
        setError(String(e));
        setPhase({ kind: "complete", ok: false, error: String(e) });
      }
    };

    const handleEvent = (event: PiOAuthEvent) => {
      switch (event.type) {
        case "oauth_challenge": {
          if (event.kind === "auth") {
            setPhase({
              kind: "auth",
              url: event.url ?? "",
              instructions: event.instructions ?? undefined,
            });
          } else {
            setPhase({
              kind: "prompt",
              message: event.message ?? "",
              placeholder: event.placeholder ?? undefined,
              allowEmpty: event.allowEmpty ?? false,
            });
            setPromptValue("");
          }
          break;
        }
        case "oauth_progress":
          setPhase({ kind: "progress", message: event.message });
          break;
        case "oauth_complete":
          setPhase({
            kind: "complete",
            ok: event.ok,
            error: event.error ?? undefined,
          });
          if (event.ok) onSaved();
          break;
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (challengeId) void piOAuthCancel(challengeId).catch(() => {});
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
    // We intentionally do not depend on `onSaved` — it's a stable
    // callback the parent owns and changing it shouldn't reset OAuth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, workingDir]);

  const handleSubmitPrompt = async () => {
    const id = challengeIdRef.current;
    if (!id) return;
    if (phase.kind !== "prompt") return;
    if (!phase.allowEmpty && !promptValue.trim()) {
      setError(t("pi_oauth_prompt_required", "This field is required."));
      return;
    }
    try {
      setError(null);
      await piOAuthSubmitInput({ challengeId: id, value: promptValue });
      setPhase({ kind: "progress", message: t("pi_oauth_progress", "Waiting on GitHub…") });
    } catch (e) {
      setError(String(e));
    }
  };

  const handleCopyUrl = () => {
    if (phase.kind === "auth") {
      // Tauri's webview doesn't expose `navigator.clipboard` as a
      // secure-context API on macOS WebKit, and asking for the
      // permission would fail; the rest of the app uses the Tauri
      // clipboard plugin for the same reason.
      void clipboardWriteText(phase.url).catch((e) => {
        setError(String(e));
      });
    }
  };

  return (
    <Modal
      title={t("pi_oauth_title", {
        label: provider.label,
        defaultValue: "Sign in to {{label}}",
      })}
      onClose={onClose}
    >
      <PhaseBody
        phase={phase}
        provider={provider}
        promptValue={promptValue}
        setPromptValue={setPromptValue}
        onCopyUrl={handleCopyUrl}
        onSubmitPrompt={handleSubmitPrompt}
        error={error}
      />

      <div className={shared.actions}>
        {phase.kind !== "complete" && (
          <button type="button" className={shared.btnDanger} onClick={onClose}>
            {t("pi_oauth_cancel", "Cancel")}
          </button>
        )}
        {phase.kind === "complete" && (
          <button type="button" className={shared.btnPrimary} onClick={onClose}>
            {t("pi_oauth_done", "Done")}
          </button>
        )}
      </div>
    </Modal>
  );
}

interface PhaseBodyProps {
  phase: Phase;
  provider: PiProvider;
  promptValue: string;
  setPromptValue: (value: string) => void;
  onCopyUrl: () => void;
  onSubmitPrompt: () => Promise<void> | void;
  error: string | null;
}

function PhaseBody({
  phase,
  provider,
  promptValue,
  setPromptValue,
  onCopyUrl,
  onSubmitPrompt,
  error,
}: PhaseBodyProps) {
  const { t } = useTranslation("settings");
  // Stable IDs so the prompt-message, verification URL, and user-code
  // inputs all get programmatic label/aria-describedby relationships
  // (placeholder + visual label don't satisfy that for screen
  // readers).
  const promptInputId = useId();
  const promptDescriptionId = useId();
  const urlInputId = useId();
  const userCodeInputId = useId();

  if (phase.kind === "starting") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Loader2 size={14} className="lucide-spinner" />
        <span>{t("pi_oauth_starting", "Starting sign-in…")}</span>
      </div>
    );
  }

  if (phase.kind === "prompt") {
    return (
      <>
        <p id={promptDescriptionId} className={shared.warning}>
          {phase.message}
        </p>
        <div className={shared.field}>
          {/* The prompt input has no visible label of its own — Pi
              writes the message as the warning paragraph above. Use
              `aria-labelledby` on the input so screen readers
              announce the prompt text when the field receives focus
              (placeholder alone is not an accessible name). */}
          <input
            id={promptInputId}
            type="text"
            className={shared.input}
            autoFocus
            aria-labelledby={promptDescriptionId}
            value={promptValue}
            placeholder={phase.placeholder}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onSubmitPrompt();
            }}
          />
          {phase.allowEmpty && (
            <p className={shared.hint}>
              {t(
                "pi_oauth_prompt_optional",
                "Leave blank to use the default (github.com).",
              )}
            </p>
          )}
        </div>
        <div className={shared.actions} style={{ marginTop: -8 }}>
          <button
            type="button"
            className={shared.btnPrimary}
            onClick={() => void onSubmitPrompt()}
          >
            {t("pi_oauth_continue", "Continue")}
          </button>
        </div>
        {error && <p className={shared.error}>{error}</p>}
      </>
    );
  }

  if (phase.kind === "auth") {
    // Pi's `instructions` for github-copilot is the user-code
    // (8-character string). For other providers it can be longer
    // human-readable text. Render both shapes — the field is
    // displayed verbatim and copy-friendly either way.
    return (
      <>
        <p className={shared.warning}>
          {t(
            "pi_oauth_auth_instructions",
            "Open the URL below to authorize Pi. You can paste this code on the verification page if asked.",
          )}
        </p>
        <div className={shared.field}>
          <label className={shared.label} htmlFor={urlInputId}>
            {t("pi_oauth_url_label", "Verification URL")}
          </label>
          <div className={shared.inputRow}>
            <input
              id={urlInputId}
              className={shared.input}
              value={phase.url}
              readOnly
            />
            <button
              type="button"
              className={shared.btn}
              onClick={onCopyUrl}
              title={t("pi_oauth_copy", "Copy")}
            >
              <Copy size={12} aria-hidden />
            </button>
            <button
              type="button"
              className={shared.btn}
              onClick={() => void openUrl(phase.url).catch(() => {})}
              title={t("pi_oauth_open", "Open")}
            >
              <ExternalLink size={12} aria-hidden />
            </button>
          </div>
        </div>
        {phase.instructions && (
          <div className={shared.field}>
            <label className={shared.label} htmlFor={userCodeInputId}>
              {t("pi_oauth_user_code", "User code")}
            </label>
            <input
              id={userCodeInputId}
              className={shared.input}
              value={phase.instructions}
              readOnly
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
        )}
        {provider.docsUrl && (
          <p className={shared.hint}>
            <a
              href={provider.docsUrl}
              onClick={(e) => {
                // Bare `<a target="_blank">` opens inside the Tauri
                // webview on some platforms; route through the
                // shell command like the rest of Settings does.
                e.preventDefault();
                if (provider.docsUrl) {
                  void openUrl(provider.docsUrl).catch(() => {});
                }
              }}
            >
              {t("pi_oauth_learn_more", "What is this? →")}
            </a>
          </p>
        )}
      </>
    );
  }

  if (phase.kind === "progress") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Loader2 size={14} className="lucide-spinner" />
        <span>{phase.message}</span>
      </div>
    );
  }

  // complete
  return (
    <p className={phase.ok ? shared.warning : shared.error}>
      {phase.ok
        ? t("pi_oauth_complete_ok", "Signed in. Refresh the Pi card to see the new models.")
        : phase.error ?? t("pi_oauth_complete_fail", "Sign-in failed.")}
    </p>
  );
}
