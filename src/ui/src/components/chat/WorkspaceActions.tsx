import { useState } from "react";
import { openWorkspaceInTerminal } from "../../services/tauri";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import styles from "./WorkspaceActions.module.css";

interface WorkspaceActionsProps {
  worktreePath: string | null;
  disabled?: boolean;
}

export function WorkspaceActions({
  worktreePath,
  disabled = false,
}: WorkspaceActionsProps) {
  const [value, setValue] = useState("");

  const handleAction = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const action = e.target.value;
    setValue(""); // Reset to placeholder

    if (!worktreePath) {
      console.error("No worktree path available");
      return;
    }

    switch (action) {
      case "open-terminal":
        try {
          await openWorkspaceInTerminal(worktreePath);
        } catch (err) {
          console.error("Failed to open terminal:", err);
          alert(`Failed to open terminal: ${err}`);
        }
        break;
      case "copy-path":
        try {
          await writeText(worktreePath);
          console.log("Path copied:", worktreePath);
        } catch (err) {
          console.error("Failed to copy path:", err);
          alert(`Failed to copy path: ${err}`);
        }
        break;
    }
  };

  return (
    <select
      className={styles.select}
      onChange={handleAction}
      disabled={disabled || !worktreePath}
      title="Workspace actions"
      aria-label="Workspace actions"
      value={value}
    >
      <option value="" disabled>
        Actions
      </option>
      <option value="open-terminal">Open in Terminal</option>
      <option value="copy-path">Copy Path</option>
    </select>
  );
}
