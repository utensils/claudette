import { AlertCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";

import styles from "./ChatPanel.module.css";

// Voice errors used to render as a single fixed-width button with
// `white-space: nowrap` + ellipsis. That collapsed long .NET exception
// chains like `Exception calling "Recognize" with "1" argument(s):
// InvalidOperationException: <real cause>` into an unactionable
// "Exception calling..." pill. This component:
//
//   * lets the message wrap (CSS-side),
//   * stays click-to-dismiss (or click-to-settings, same as before),
//   * adds a tiny "Logs" affordance that opens the daily diagnostics
//     log directory — same path the Settings → Diagnostics panel uses —
//     and a "Copy" affordance so users can paste the full error into a
//     bug report without retyping a multi-line stack chain.
//
// The `Logs` and `Copy` chips only render in the dismissable variant.
// The settings-redirect variant (used when the provider needs setup)
// keeps a single click target so the call-to-action stays unambiguous.
//
// Errors that don't relate to System.Speech still flow through here —
// the chip row is harmless on macOS / Linux Whisper failures and gives
// every voice failure a single consistent "show me what happened"
// surface.

export interface VoiceErrorPillProps {
  error: string;
  opensSettings: boolean;
  onOpenSettings: () => void;
  onDismiss: () => void;
  dismissHint: string;
}

export function VoiceErrorPill({
  error,
  opensSettings,
  onOpenSettings,
  onDismiss,
  dismissHint,
}: VoiceErrorPillProps): ReactElement {
  // Same `chat` namespace ChatInputArea uses for its own voice-related
  // strings — keeps `voice_error_*` keys in one place rather than
  // splitting them across namespaces.
  const { t } = useTranslation("chat");
  // `Copied` is a transient label swap, not a separate state machine —
  // a 1500 ms timeout flips back to the default. Plain useState beats
  // a custom hook for something this small.
  const [copied, setCopied] = useState(false);

  if (opensSettings) {
    return (
      <button
        type="button"
        className={styles.voiceErrorBtn}
        onClick={onOpenSettings}
        title={error}
      >
        <AlertCircle size={12} className={styles.voiceErrorIcon} aria-hidden="true" />
        <span className={styles.voiceErrorText}>{error}</span>
      </button>
    );
  }

  // The dismissable variant is split into a parent <button> for the
  // primary action (dismiss) and a child <span> wrapping the chip
  // affordances. The chips use `e.stopPropagation()` because they're
  // siblings of the dismiss action visually, but DOM-nested for layout
  // — without stopPropagation, clicking "Logs" would also dismiss the
  // pill before the user could see anything.
  return (
    <span className={styles.voiceErrorBtn} role="alert">
      <AlertCircle size={12} className={styles.voiceErrorIcon} aria-hidden="true" />
      <button
        type="button"
        className={styles.voiceErrorText}
        onClick={onDismiss}
        title={`${error}\n\n${dismissHint}`}
        // Reset to a transparent button so the parent .voiceErrorBtn's
        // styling drives appearance — this child is only here for the
        // click+keyboard target on the message text itself.
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          color: "inherit",
          font: "inherit",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        {error}
      </button>
      <span className={styles.voiceErrorActions}>
        <button
          type="button"
          className={styles.voiceErrorAction}
          onClick={(e) => {
            e.stopPropagation();
            void invoke("open_log_dir").catch(() => {
              // Silent failure is fine — the user can still copy the
              // error text via the adjacent affordance, and the daily
              // log already captured the underlying cause via the
              // Rust-side `tracing::error!` call. Logging this would
              // recurse through the same bridge.
            });
          }}
          title={t("voice_error_open_logs_title")}
        >
          {t("voice_error_open_logs")}
        </button>
        <button
          type="button"
          className={styles.voiceErrorAction}
          onClick={(e) => {
            e.stopPropagation();
            void clipboardWriteText(error)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {
                // Browsers in some sandboxed devshells refuse clipboard
                // writes — same fail-quiet rationale as Logs above.
              });
          }}
          title={t("voice_error_copy_title")}
        >
          {copied ? t("voice_error_copied") : t("voice_error_copy")}
        </button>
      </span>
    </span>
  );
}
