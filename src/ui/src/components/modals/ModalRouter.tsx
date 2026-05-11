import { useAppStore } from "../../stores/useAppStore";
import { AddRepoModal } from "./AddRepoModal";
import { AddRemoteModal } from "./AddRemoteModal";
import { DeleteWorkspaceModal } from "./DeleteWorkspaceModal";
import { RemoveRepoModal } from "./RemoveRepoModal";
import { RelinkRepoModal } from "./RelinkRepoModal";
import { RollbackModal } from "./RollbackModal";
import { ShareModal } from "./ShareModal";
import { ConfirmSetupScriptModal } from "./ConfirmSetupScriptModal";
import { ConfirmArchiveScriptModal } from "./ConfirmArchiveScriptModal";
import { McpSelectionModal } from "./McpSelectionModal";
import { ImportWorktreesModal } from "./ImportWorktreesModal";
import { ConfirmNightlyChannelModal } from "./ConfirmNightlyChannelModal";
import { MissingCliModal } from "./MissingCliModal";
import { KeyboardShortcutsModal } from "./KeyboardShortcutsModal";
import { EnvTrustModal } from "./EnvTrustModal";

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
    case "confirmArchiveScript":
      return <ConfirmArchiveScriptModal />;
    case "mcpSelection":
      return <McpSelectionModal />;
    case "importWorktrees":
      return <ImportWorktreesModal />;
    case "confirmNightlyChannel":
      return <ConfirmNightlyChannelModal />;
    case "missingCli":
      return <MissingCliModal />;
    case "keyboard-shortcuts":
      return <KeyboardShortcutsModal />;
    case "envTrust":
      return <EnvTrustModal />;
    default:
      return null;
  }
}
