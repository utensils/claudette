import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { runWorkspaceSetup, setSetupScriptAutoRun } from "../../services/tauri";
import {
  recordSetupScriptError,
  recordSetupScriptResult,
} from "../../utils/setupScriptMessage";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export function ConfirmSetupScriptModal() {
  const { t } = useTranslation("modals");
  const { t: tCommon } = useTranslation("common");
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const addToast = useAppStore((s) => s.addToast);
  const updateRepository = useAppStore((s) => s.updateRepository);
  const [loading, setLoading] = useState(false);
  const [alwaysRun, setAlwaysRun] = useState(false);

  const workspaceId = modalData.workspaceId as string;
  const sessionId = modalData.sessionId as string;
  const script = modalData.script as string;
  const source = modalData.source as string;
  const repoId = modalData.repoId as string;

  const handleRun = async () => {
    setLoading(true);
    const workspaceName = useAppStore
      .getState()
      .workspaces.find((w) => w.id === workspaceId)?.name;
    try {
      if (alwaysRun && repoId) {
        await setSetupScriptAutoRun(repoId, true);
        updateRepository(repoId, { setup_script_auto_run: true });
      }
      const sr = await runWorkspaceSetup(workspaceId);
      if (sr) {
        recordSetupScriptResult(sessionId, workspaceId, sr, {
          addChatMessage,
          addToast,
          workspaceName,
        });
      }
      closeModal();
    } catch (e) {
      recordSetupScriptError(sessionId, workspaceId, e, {
        addChatMessage,
        addToast,
        workspaceName,
      });
      closeModal();
    }
  };

  const label = source === "repo" ? ".claudette.json" : t("setup_script_source_repo_settings");

  return (
    <Modal title={t("setup_script_title")} onClose={closeModal}>
      <div className={shared.warning}>
        <Trans
          i18nKey="setup_script_warning"
          ns="modals"
          values={{ source: label }}
          components={{ strong: <strong /> }}
        />
      </div>
      <div className={shared.field}>
        <label className={shared.label}>{t("setup_script_label")}</label>
        <pre className={shared.scriptPreview}>{script}</pre>
      </div>
      <div className={shared.field}>
        <label className={shared.checkboxRow}>
          <input
            type="checkbox"
            checked={alwaysRun}
            onChange={(e) => setAlwaysRun(e.target.checked)}
          />
          {t("setup_script_always_run")}
        </label>
      </div>
      <div className={shared.actions}>
        <button className={shared.btn} onClick={closeModal}>
          {tCommon("skip")}
        </button>
        <button
          className={shared.btnPrimary}
          onClick={handleRun}
          disabled={loading}
        >
          {loading ? t("setup_script_running") : t("setup_script_confirm")}
        </button>
      </div>
    </Modal>
  );
}
