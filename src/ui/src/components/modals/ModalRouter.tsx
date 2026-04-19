import { useAppStore } from "../../stores/useAppStore";
import { AddRepoModal } from "./AddRepoModal";
import { AddRemoteModal } from "./AddRemoteModal";
import { DeleteWorkspaceModal } from "./DeleteWorkspaceModal";
import { RemoveRepoModal } from "./RemoveRepoModal";
import { RelinkRepoModal } from "./RelinkRepoModal";
import { RollbackModal } from "./RollbackModal";
import { ShareModal } from "./ShareModal";
import { ConfirmSetupScriptModal } from "./ConfirmSetupScriptModal";
import { McpSelectionModal } from "./McpSelectionModal";
import { ImportWorktreesModal } from "./ImportWorktreesModal";
import { ConfirmNightlyChannelModal } from "./ConfirmNightlyChannelModal";

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
    case "relinkRepo":
      return <RelinkRepoModal />;
    case "rollback":
      return <RollbackModal />;
    case "share":
      return <ShareModal />;
    case "confirmSetupScript":
      return <ConfirmSetupScriptModal />;
    case "mcpSelection":
      return <McpSelectionModal />;
    case "importWorktrees":
      return <ImportWorktreesModal />;
    case "confirmNightlyChannel":
      return <ConfirmNightlyChannelModal />;
    default:
      return null;
  }
}
