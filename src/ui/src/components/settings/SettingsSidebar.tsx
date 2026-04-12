import { useAppStore } from "../../stores/useAppStore";
import { RepoIcon } from "../shared/RepoIcon";
import styles from "./Settings.module.css";

const APP_SECTIONS = [
  { id: "general", label: "General" },
  { id: "models", label: "Models" },
  { id: "appearance", label: "Appearance" },
  { id: "notifications", label: "Notifications" },
  { id: "git", label: "Git" },
];

const MORE_SECTIONS = [
  { id: "experimental", label: "Experimental" },
  { id: "advanced", label: "Advanced" },
];

export function SettingsSidebar() {
  const settingsSection = useAppStore((s) => s.settingsSection);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const repositories = useAppStore((s) => s.repositories);

  return (
    <div className={styles.sidebar}>
      <button className={styles.backLink} onClick={closeSettings}>
        &larr; Back to app
      </button>

      {APP_SECTIONS.map((s) => (
        <button
          key={s.id}
          className={
            settingsSection === s.id ? styles.navItemActive : styles.navItem
          }
          onClick={() => setSettingsSection(s.id)}
        >
          {s.label}
        </button>
      ))}

      <div className={styles.groupLabel}>More</div>
      {MORE_SECTIONS.map((s) => (
        <button
          key={s.id}
          className={
            settingsSection === s.id ? styles.navItemActive : styles.navItem
          }
          onClick={() => setSettingsSection(s.id)}
        >
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
