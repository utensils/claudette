// Modal version of the Pi provider picker, used by the `/login` slash
// command. Pi is multi-provider (unlike Codex's single OAuth flow),
// so `/login` for a Pi-selected workspace opens this picker rather
// than launching one specific OAuth flow. After the user finishes a
// configure/sign-in, the modal stays open so they can configure more
// (e.g. "I want both Copilot AND OpenRouter"); they dismiss it when
// they're done.

import { useTranslation } from "react-i18next";

import { PiProviderManager } from "../settings/PiProviderManager";
import { Modal } from "./Modal";
import shared from "./shared.module.css";

export interface PiLoginModalProps {
  /** Workspace cwd for the underlying control session. Empty string
   *  is fine if not in a workspace context. */
  workingDir: string;
  onClose: () => void;
}

export function PiLoginModal({ workingDir, onClose }: PiLoginModalProps) {
  const { t } = useTranslation("modals");
  return (
    <Modal title={t("pi_login_title", "Sign in to a Pi provider")} onClose={onClose} wide>
      <p className={shared.warning}>
        {t(
          "pi_login_intro",
          "Pi can route to many providers. Configure one or more below — they remain available across workspaces.",
        )}
      </p>
      <PiProviderManager workingDir={workingDir} />
      <div className={shared.actions}>
        <button type="button" className={shared.btn} onClick={onClose}>
          {t("pi_login_done", "Done")}
        </button>
      </div>
    </Modal>
  );
}
