import { SlidersHorizontal, Cpu, Palette, Bell, GitBranch, FlaskConical, BarChart3, Puzzle } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import { RepoIcon } from "../shared/RepoIcon";
import styles from "./Settings.module.css";

const APP_SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "models", label: "Models", icon: Cpu },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  {
    id: "claude-code-plugins",
    label: "Claude Code Plugins",
    icon: Puzzle,
  },
];

const MORE_SECTIONS = [
  { id: "experimental", label: "Experimental", icon: FlaskConical },
];

export function getAppSections(pluginManagementEnabled: boolean) {
  return APP_SECTIONS.filter(
    (section) =>
      section.id !== "claude-code-plugins" || pluginManagementEnabled,
  );
}

export function SettingsSidebar() {
  const settingsSection = useAppStore((s) => s.settingsSection);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const repositories = useAppStore((s) => s.repositories);
  const usageInsightsEnabled = useAppStore((s) => s.usageInsightsEnabled);
  const pluginManagementEnabled = useAppStore((s) => s.pluginManagementEnabled);

  return (
    <div className={styles.sidebar}>
      <button className={styles.backLink} onClick={closeSettings}>
        &larr; Back to app
      </button>

      {getAppSections(pluginManagementEnabled).map((s) => (
        <button
          key={s.id}
          className={
            settingsSection === s.id ? styles.navItemActive : styles.navItem
          }
          onClick={() => setSettingsSection(s.id)}
        >
          <s.icon size={14} />
          {s.label}
        </button>
      ))}

      {usageInsightsEnabled && (
        <button
          className={
            settingsSection === "usage" ? styles.navItemActive : styles.navItem
          }
          onClick={() => setSettingsSection("usage")}
        >
          <BarChart3 size={14} />
          Usage
        </button>
      )}

      <div className={styles.groupLabel}>More</div>
      {MORE_SECTIONS.map((s) => (
        <button
          key={s.id}
          className={
            settingsSection === s.id ? styles.navItemActive : styles.navItem
          }
          onClick={() => setSettingsSection(s.id)}
        >
          <s.icon size={14} />
          {s.label}
        </button>
      ))}

      <div className={styles.groupLabel}>Repositories</div>
      {repositories.map((repo) => {
        const sectionId = `repo:${repo.id}`;
        return (
          <button
            key={repo.id}
            className={
              settingsSection === sectionId
                ? styles.navItemActive
                : styles.navItem
            }
            onClick={() => setSettingsSection(sectionId)}
          >
            {repo.icon && <RepoIcon icon={repo.icon} size={14} className={styles.repoIcon} />}
            <span className={styles.repoName}>{repo.name}</span>
          </button>
        );
      })}
    </div>
  );
}
