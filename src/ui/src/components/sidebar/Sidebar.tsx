import { useAppStore } from "../../stores/useAppStore";
import { archiveWorkspace, restoreWorkspace } from "../../services/tauri";
import { Settings, Link, X } from "lucide-react";
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
  const openModal = useAppStore((s) => s.openModal);
  const updateWorkspace = useAppStore((s) => s.updateWorkspace);

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
                  {repo.icon && (
                    <span className={styles.repoIcon}>{repo.icon} </span>
                  )}
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
                        openModal("createWorkspace", {
                          repoId: repo.id,
                          repoName: repo.name,
                        });
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
