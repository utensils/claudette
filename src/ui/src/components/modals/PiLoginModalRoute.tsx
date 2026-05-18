// Thin route binding for the Pi login modal. Pulls `workingDir` out
// of `modalData` (set by `startPiLogin` in ChatPanel) and wires the
// store's closeModal action — keeps the dumb modal component
// reusable from other call sites that aren't routed through the
// modal stack.

import { useAppStore } from "../../stores/useAppStore";
import { PiLoginModal } from "./PiLoginModal";

export function PiLoginModalRoute() {
  const closeModal = useAppStore((s) => s.closeModal);
  const modalData = useAppStore((s) => s.modalData);
  const workingDir =
    typeof modalData?.workingDir === "string" ? modalData.workingDir : "";
  return <PiLoginModal workingDir={workingDir} onClose={closeModal} />;
}
