import { useAppStore } from "../../stores/useAppStore";
import styles from "./Toast.module.css";

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.container}>
      {toasts.map((t) => (
        <div key={t.id} className={styles.toast}>
          <span className={styles.message}>{t.message}</span>
          <button
            className={styles.dismiss}
            onClick={() => removeToast(t.id)}
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
