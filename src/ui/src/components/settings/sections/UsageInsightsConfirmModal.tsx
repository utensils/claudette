import { useCallback, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../modals/Modal";
import { openUrl } from "../../../services/tauri";
import shared from "../../modals/shared.module.css";

const ANTHROPIC_TOS_URL = "https://www.anthropic.com/legal/consumer-terms";

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

function handleExternalLink(href: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    void openUrl(href).catch((err) => console.warn("openUrl failed:", err));
  };
}

export function UsageInsightsConfirmModal({ onConfirm, onCancel }: Props) {
  const { t } = useTranslation("settings");

  const handleConfirm = useCallback(() => {
    onConfirm();
  }, [onConfirm]);

  return (
    <Modal title={t("usage_insights_confirm_title")} onClose={onCancel}>
      <div className={shared.warning}>
        <p style={{ margin: 0 }}>{t("usage_insights_confirm_how_it_works")}</p>
      </div>

      <div className={shared.warning} style={{ marginTop: 8 }}>
        <strong>{t("usage_insights_confirm_warning_heading")}</strong>
        <p style={{ margin: "6px 0 0 0" }}>
          {t("usage_insights_confirm_warning_body")}{" "}
          <a
            href={ANTHROPIC_TOS_URL}
            target="_blank"
            rel="noreferrer"
            onClick={handleExternalLink(ANTHROPIC_TOS_URL)}
          >
            {t("usage_insights_confirm_tos_link")}
          </a>
          .
        </p>
      </div>

      <div className={shared.actions}>
        <button className={shared.btn} onClick={onCancel} type="button">
          {t("usage_insights_confirm_cancel")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleConfirm}
          type="button"
          autoFocus
        >
          {t("usage_insights_confirm_enable")}
        </button>
      </div>
    </Modal>
  );
}
