import { useAppStore } from "../../stores/useAppStore";
import { AddRepoModal } from "./AddRepoModal";
import { AddRemoteModal } from "./AddRemoteModal";
import { DeleteWorkspaceModal } from "./DeleteWorkspaceModal";
import { RemoveRepoModal } from "./RemoveRepoModal";
import { RepoSettingsModal } from "./RepoSettingsModal";
import { RelinkRepoModal } from "./RelinkRepoModal";
import { AppSettingsModal } from "./AppSettingsModal";
import { ShareModal } from "./ShareModal";
import { ConfirmSetupScriptModal } from "./ConfirmSetupScriptModal";

export function ModalRouter() {
  const activeModal = useAppStore((s) => s.activeModal);

  switch (activeModal) {
    case "addRepo":
      return <AddRepoModal />;
    case "addRemote":
      return <AddRemoteModal />;
    case "deleteWorkspace":
      return <DeleteWorkspaceModal />;
    case "removeRepo":
      return <RemoveRepoModal />;
    case "repoSettings":
      return <RepoSettingsModal />;
    case "relinkRepo":
      return <RelinkRepoModal />;
    case "appSettings":
      return <AppSettingsModal />;
    case "share":
      return <ShareModal />;
    case "confirmSetupScript":
      return <ConfirmSetupScriptModal />;
    default:
      return null;
  }
}
