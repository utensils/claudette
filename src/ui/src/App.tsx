import { useEffect } from "react";
import { useAppStore } from "./stores/useAppStore";
import { loadInitialData, getAppSetting } from "./services/tauri";
import { AppLayout } from "./components/layout/AppLayout";
import "./styles/theme.css";

function App() {
  const setRepositories = useAppStore((s) => s.setRepositories);
  const setWorkspaces = useAppStore((s) => s.setWorkspaces);
  const setWorktreeBaseDir = useAppStore((s) => s.setWorktreeBaseDir);
  const setDefaultBranches = useAppStore((s) => s.setDefaultBranches);
  const setTerminalFontSize = useAppStore((s) => s.setTerminalFontSize);

  useEffect(() => {
    loadInitialData().then((data) => {
      setRepositories(data.repositories);
      setWorkspaces(data.workspaces);
      setWorktreeBaseDir(data.worktree_base_dir);
      setDefaultBranches(data.default_branches);
    });
    getAppSetting("terminal_font_size")
      .then((val) => {
        if (val) {
          const size = parseInt(val, 10);
          if (size >= 8 && size <= 24) setTerminalFontSize(size);
        }
      })
      .catch((err) => console.error("Failed to load terminal font size:", err));
  }, [setRepositories, setWorkspaces, setWorktreeBaseDir, setDefaultBranches, setTerminalFontSize]);

  return <AppLayout />;
}

export default App;
