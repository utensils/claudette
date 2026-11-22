import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import styles from "./Toast.module.css";

export function ToastContainer() {
  const { t } = useTranslation();
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.container} role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={styles.toast}>
          <span className={styles.message}>{toast.message}</span>
          <button
            className={styles.dismiss}
            onClick={() => removeToast(toast.id)}
            aria-label={t("toast_dismiss")}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
