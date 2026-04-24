import { useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { openUrl } from "../../services/tauri";
import { Modal } from "./Modal";
import shared from "./shared.module.css";
import styles from "./MissingCliModal.module.css";

export interface InstallOption {
  label: string;
  command?: string;
  url?: string;
}

export interface MissingCliData {
  tool: string;
  display_name: string;
  purpose: string;
  platform: string;
  install_options: InstallOption[];
}

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function isMissingCliData(value: unknown): value is MissingCliData {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tool === "string" &&
    typeof v.display_name === "string" &&
    typeof v.purpose === "string" &&
    typeof v.platform === "string" &&
    Array.isArray(v.install_options)
  );
}

export function MissingCliModal() {
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const [copied, setCopied] = useState<number | null>(null);

  const data = isMissingCliData(modalData) ? modalData : null;
  if (!data) return null;

  const platformLabel = PLATFORM_LABEL[data.platform] ?? data.platform;

  const handleCopy = async (cmd: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(idx);
      setTimeout(() => setCopied((c) => (c === idx ? null : c)), 1500);
    } catch {
      // Clipboard API can reject in some sandboxes — silently ignore.
    }
  };

  const handleOpen = (url: string) => {
    void openUrl(url).catch(() => {});
  };

  return (
    <Modal title={`${data.display_name} not installed`} onClose={closeModal}>
      <p className={styles.purpose}>{data.purpose}</p>
      <div className={styles.platformLine}>
        Detected platform: <strong>{platformLabel}</strong>
      </div>
      {data.install_options.length > 0 ? (
        <ul className={styles.optionList}>
          {data.install_options.map((opt, idx) => (
            <li key={idx} className={styles.option}>
              <div className={styles.optionLabel}>{opt.label}</div>
              {opt.command && (
                <div className={styles.commandRow}>
                  <code className={styles.code}>{opt.command}</code>
                  <button
                    type="button"
                    className={shared.btn}
                    onClick={() => void handleCopy(opt.command!, idx)}
                  >
                    {copied === idx ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
              {opt.url && (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => handleOpen(opt.url!)}
                >
                  {opt.url}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className={shared.warning}>
          No installation guidance is available for this tool — please consult
          its documentation.
        </div>
      )}
      <div className={shared.actions}>
        <button className={shared.btnPrimary} onClick={closeModal}>
          Close
        </button>
      </div>
    </Modal>
  );
}
