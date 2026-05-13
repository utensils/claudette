import { useState } from "react";
import { Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import styles from "../settings/Settings.module.css";

export function ClaudeAuthCodeForm({
  onSubmit,
}: {
  onSubmit: (code: string) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const trimmed = code.trim();

  return (
    <form
      className={styles.authCodeForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed || submitting) return;
        setSubmitting(true);
        void (async () => {
          try {
            await onSubmit(trimmed);
            setCode("");
          } catch {
            // The shared auth controller owns the visible error state.
          } finally {
            setSubmitting(false);
          }
        })();
      }}
    >
      <input
        className={styles.authCodeInput}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder={t("auth_code_placeholder")}
        autoComplete="one-time-code"
      />
      <button
        className={styles.iconBtn}
        type="submit"
        disabled={!trimmed || submitting}
      >
        <Send size={12} /> {t("auth_submit_code")}
      </button>
    </form>
  );
}
