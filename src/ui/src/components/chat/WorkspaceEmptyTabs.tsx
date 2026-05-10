import { memo, useEffect, useMemo, useState } from "react";
import {
  Plus,
  Command,
  FolderGit2,
  X,
  Clock,
  GitBranch,
  MessageSquare,
} from "lucide-react";
import { executeNewTab } from "../../hotkeys/contextActions";
import { useAppStore } from "../../stores/useAppStore";
import { getHotkeyLabel } from "../../hotkeys/display";
import { isMacHotkeyPlatform } from "../../hotkeys/platform";
import { listChatSessions, restoreChatSession } from "../../services/tauri";
import type { Workspace } from "../../types/workspace";
import type { Repository } from "../../types/repository";
import type { ChatSession } from "../../types/chat";
import { RepoIcon } from "../shared/RepoIcon";
// Reuse the welcome card's visual chrome — same scoped class names, no
// style duplication. CSS modules share scope across consumers of the
// same .module.css file, so importing it here gives us the identical
// card look the user explicitly asked for ("this same screen").
import styles from "../layout/WelcomeEmptyState.module.css";

export interface WorkspaceEmptyTabsProps {
  workspace: Workspace;
  repository: Repository | undefined;
}

/** Format a UTC ISO timestamp as a compact relative label ("just now", "5m
 *  ago", "Apr 12"). Mirrors the Recent Sessions cadence in the reference
 *  design — short enough to fit in a meta column, precise enough to
 *  distinguish today's work from last week's. */
function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Empty state shown when a workspace has zero open tabs (no chat sessions,
 *  no diff tabs, no file tabs). The strip's `+` button is still visible
 *  above this card; the card surfaces the keyboard shortcut and a list of
 *  recently archived sessions the user can resume. */
export const WorkspaceEmptyTabs = memo(function WorkspaceEmptyTabs({
  workspace,
  repository,
}: WorkspaceEmptyTabsProps) {
  const keybindings = useAppStore((s) => s.keybindings);
  const isMac = isMacHotkeyPlatform();
  const newTabLabel = getHotkeyLabel("global.new-tab", keybindings, isMac) ?? "⌘T";
  const closeTabLabel = getHotkeyLabel("global.close-tab", keybindings, isMac) ?? "⌘W";
  const fuzzyFinderLabel =
    getHotkeyLabel("global.toggle-fuzzy-finder", keybindings, isMac) ?? "⌘K";

  const addChatSession = useAppStore((s) => s.addChatSession);
  const selectSession = useAppStore((s) => s.selectSession);

  // Pull archived sessions for this workspace so the user can resume one
  // instead of starting fresh. List is small (UI shows the top 5) so a
  // single fetch on mount is cheap; keep the resulting set in component
  // state so the cards can disappear individually as we restore them.
  const [archivedSessions, setArchivedSessions] = useState<ChatSession[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    listChatSessions(workspace.id, true)
      .then((all) => {
        if (cancelled) return;
        const archived = all
          // Only resumable sessions: archived AND has at least one turn.
          // The auto-create-on-close path historically left a trail of
          // empty "New chat" placeholders; surfacing those as resume
          // candidates wastes a row and confuses the user about what's
          // worth coming back to.
          .filter((s) => s.status === "Archived" && s.turn_count > 0)
          .sort((a, b) => {
            // Most-recently archived first — falling back to created_at when
            // archived_at is somehow null (older rows pre-archived_at column).
            const at = a.archived_at ?? a.created_at;
            const bt = b.archived_at ?? b.created_at;
            return bt.localeCompare(at);
          })
          .slice(0, 5);
        setArchivedSessions(archived);
      })
      .catch((err) => {
        console.error("[WorkspaceEmptyTabs] failed to load archived:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  const handleResume = async (session: ChatSession) => {
    if (restoringId) return;
    setRestoringId(session.id);
    try {
      const restored = await restoreChatSession(session.id);
      addChatSession(restored);
      selectSession(workspace.id, restored.id);
    } catch (err) {
      console.error("[WorkspaceEmptyTabs] failed to restore:", err);
    } finally {
      setRestoringId(null);
    }
  };

  // Workspace age — gives the chip a meaningful "still running" stat.
  const workspaceAge = useMemo(
    () => formatRelative(workspace.created_at),
    [workspace.created_at],
  );
  const totalSessions = useMemo(
    () =>
      archivedSessions.length /* archived shown */ +
      0, /* live sessions = 0 in this view by definition */
    [archivedSessions.length],
  );

  return (
    <div className={styles.welcome}>
      <div className={styles.card}>
        <div className={styles.header}>
          <h1 className={styles.title}>Pick up {workspace.name}.</h1>
          <p className={styles.subtitle}>
            The workspace is still running — start a fresh chat session, or
            resume one of your past sessions below.
          </p>
        </div>

        {repository && (
          <div className={styles.activeProject} aria-disabled="true">
            <span className={styles.activeProjectHead}>
              {repository.icon && (
                <RepoIcon
                  icon={repository.icon}
                  size={14}
                  className={styles.activeProjectIcon}
                />
              )}
              <span className={styles.activeProjectName}>
                {repository.name}
              </span>
              <span className={styles.activeProjectPath}>
                {workspace.worktree_path ?? repository.path}
              </span>
            </span>
            <span className={styles.activeProjectMeta}>
              <span>
                <GitBranch size={11} aria-hidden="true" />
                {workspace.branch_name}
              </span>
              {workspaceAge && (
                <span>
                  <Clock size={11} aria-hidden="true" />
                  created {workspaceAge}
                </span>
              )}
              {totalSessions > 0 && (
                <span>
                  <MessageSquare size={11} aria-hidden="true" />
                  {totalSessions} past{" "}
                  {totalSessions === 1 ? "session" : "sessions"}
                </span>
              )}
            </span>
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={() => executeNewTab()}
          >
            <Plus size={14} />
            New Session
          </button>
        </div>

        {archivedSessions.length > 0 && (
          <section className={styles.section}>
            <h2 className={styles.sectionLabel}>Recent Sessions</h2>
            <ul className={styles.projectList}>
              {archivedSessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    className={styles.projectRow}
                    onClick={() => handleResume(session)}
                    disabled={restoringId !== null}
                    title={`Resume ${session.name}`}
                  >
                    <Clock
                      size={14}
                      className={styles.projectRowIcon}
                      aria-hidden="true"
                    />
                    <span className={styles.projectRowBody}>
                      <span className={styles.projectRowName}>
                        {session.name}
                      </span>
                      <span className={styles.projectRowPath}>
                        archived{" "}
                        {formatRelative(
                          session.archived_at ?? session.created_at,
                        )}
                      </span>
                    </span>
                    <span className={styles.projectRowMeta}>
                      <span>
                        {session.turn_count}{" "}
                        {session.turn_count === 1 ? "turn" : "turns"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.section}>
          <h2 className={styles.sectionLabel}>Tips</h2>
          <ul className={styles.tips}>
            <li>
              <Command size={12} className={styles.tipIcon} />
              <span>
                <kbd className={styles.kbd}>{newTabLabel}</kbd> opens a new
                chat session in this workspace.
              </span>
            </li>
            <li>
              <X size={12} className={styles.tipIcon} />
              <span>
                <kbd className={styles.kbd}>{closeTabLabel}</kbd> closes the
                active tab.
              </span>
            </li>
            <li>
              <FolderGit2 size={12} className={styles.tipIcon} />
              <span>
                Click the <strong>+</strong> in the tab strip above for a
                context menu with resumable Claude sessions.
              </span>
            </li>
            <li>
              <Clock size={12} className={styles.tipIcon} />
              <span>
                <kbd className={styles.kbd}>{fuzzyFinderLabel}</kbd> jumps to
                another workspace via the fuzzy finder.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
});
