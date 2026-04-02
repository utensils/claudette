import { useRef } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  archiveWorkspace,
  restoreWorkspace,
  generateWorkspaceName,
  createWorkspace,
} from "../../services/tauri";
import { Settings, Link, X } from "lucide-react";
import { RepoIcon } from "../shared/RepoIcon";
import styles from "./Sidebar.module.css";


export function Sidebar() {
  const repositories = useAppStore((s) => s.repositories);
  const workspaces = useAppStore((s) => s.workspaces);
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);
  const sidebarFilter = useAppStore((s) => s.sidebarFilter);
  const setSidebarFilter = useAppStore((s) => s.setSidebarFilter);
  const repoCollapsed = useAppStore((s) => s.repoCollapsed);
  const toggleRepoCollapsed = useAppStore((s) => s.toggleRepoCollapsed);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const openModal = useAppStore((s) => s.openModal);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);

  const creatingRef = useRef(false);

  const handleCreateWorkspace = async (repoId: string) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const name = await generateWorkspaceName();
      const result = await createWorkspace(repoId, name);
      addWorkspace(result.workspace);
      selectWorkspace(result.workspace.id);
      if (result.setup_result) {
        const sr = result.setup_result;
        const label = sr.source === "repo" ? ".claudette.json" : "settings";
        const status = sr.success ? "completed" : sr.timed_out ? "timed out" : "failed";
        addChatMessage(result.workspace.id, {
          id: crypto.randomUUID(),
          workspace_id: result.workspace.id,
          role: "System",
          content: `Setup script (${label}) ${status}${sr.output ? `:\n${sr.output}` : ""}`,
          cost_usd: null,
          duration_ms: null,
          created_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.error("Failed to create workspace:", e);
    } finally {
      creatingRef.current = false;
    }
  };

  const filteredWorkspaces = workspaces.filter((ws) => {
    if (sidebarFilter === "active") return ws.status === "Active";
    if (sidebarFilter === "archived") return ws.status === "Archived";
    return true;
  });

  const handleArchive = async (wsId: string) => {
    try {
      await archiveWorkspace(wsId);
      updateWorkspace(wsId, {
        status: "Archived",
        worktree_path: null,
        agent_status: "Stopped",
      });
      if (selectedWorkspaceId === wsId) selectWorkspace(null);
    } catch {
      // ignore
    }
  };

  const handleRestore = async (wsId: string) => {
    try {
      const path = await restoreWorkspace(wsId);
      updateWorkspace(wsId, { status: "Active", worktree_path: path });
    } catch {
      // ignore
    }
  };

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.title}>Workspaces</span>
      </div>

      <div className={styles.filters}>
        {(["all", "active", "archived"] as const).map((f) => (
          <button
            key={f}
            className={`${styles.filterBtn} ${sidebarFilter === f ? styles.filterActive : ""}`}
            onClick={() => setSidebarFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      <div className={styles.list}>
        {repositories.map((repo) => {
          const collapsed = repoCollapsed[repo.id];
          const repoWorkspaces = filteredWorkspaces.filter(
            (ws) => ws.repository_id === repo.id
          );

          return (
            <div key={repo.id} className={styles.repoGroup}>
              <div
                className={styles.repoHeader}
                onClick={() => toggleRepoCollapsed(repo.id)}
              >
                <span className={styles.chevron}>
                  {collapsed ? "›" : "⌄"}
                </span>
                <span className={styles.repoName}>
                  {repo.icon && <RepoIcon icon={repo.icon} className={styles.repoIcon} />}
                  {repo.name}
                </span>
                {!repo.path_valid && (
                  <span className={styles.invalidBadge}>!</span>
                )}
                {repo.path_valid ? (
                  <>
                    <button
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCreateWorkspace(repo.id);
                      }}
                      title="New workspace"
                    >
                      +
                    </button>
                    <button
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        openModal("repoSettings", { repoId: repo.id });
                      }}
                      title="Settings"
                    >
                      <Settings size={12} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        openModal("relinkRepo", {
                          repoId: repo.id,
                          repoName: repo.name,
                        });
                      }}
                      title="Re-link"
                    >
                      <Link size={12} />
                    </button>
                    <button
                      className={styles.iconBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        openModal("removeRepo", {
                          repoId: repo.id,
                          repoName: repo.name,
                        });
                      }}
                      title="Remove"
                    >
                      <X size={12} />
                    </button>
                  </>
                )}
              </div>

              {!collapsed &&
                repoWorkspaces.map((ws) => (
                  <div
                    key={ws.id}
                    className={`${styles.wsItem} ${selectedWorkspaceId === ws.id ? styles.wsSelected : ""}`}
                    onClick={() => selectWorkspace(ws.id)}
                  >
                    <span
                      className={styles.statusDot}
                      style={{
                        background:
                          ws.agent_status === "Running"
                            ? "var(--status-running)"
                            : ws.agent_status === "Stopped"
                              ? "var(--status-stopped)"
                              : "var(--status-idle)",
                      }}
                    />
                    <div className={styles.wsInfo}>
                      <span className={styles.wsName}>{ws.name}</span>
                      <span className={styles.wsBranch}>{ws.branch_name}</span>
                    </div>
                    <div className={styles.wsActions}>
                      {ws.status === "Active" ? (
                        <button
                          className={styles.iconBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleArchive(ws.id);
                          }}
                          title="Archive"
                        >
                          <X size={12} />
                        </button>
                      ) : (
                        <>
                          <button
                            className={styles.iconBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRestore(ws.id);
                            }}
                            title="Restore"
                          >
                            ↺
                          </button>
                          <button
                            className={styles.iconBtn}
                            onClick={(e) => {
                              e.stopPropagation();
                              openModal("deleteWorkspace", {
                                wsId: ws.id,
                                wsName: ws.name,
                              });
                            }}
                            title="Delete"
                          >
                            <X size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          );
        })}
      </div>

      <div className={styles.footer}>
        <button
          className={styles.addRepoBtn}
          onClick={() => openModal("addRepo")}
        >
          + Add repository
        </button>
        <button
          className={styles.settingsBtn}
          onClick={() => openModal("appSettings")}
          title="Settings"
        >
          <Settings size={14} />
        </button>
      </div>
    </div>
  );
}
