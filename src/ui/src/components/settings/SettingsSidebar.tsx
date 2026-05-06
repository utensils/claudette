import {
  SlidersHorizontal,
  Cpu,
  Palette,
  Bell,
  FileCode,
  GitBranch,
  FlaskConical,
  BarChart3,
  Puzzle,
  Bookmark,
  Globe,
  Keyboard,
  Terminal,
  HelpCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/useAppStore";
import { RepoIcon } from "../shared/RepoIcon";
import styles from "./Settings.module.css";

export function getAppSections(
  pluginManagementEnabled: boolean,
  communityRegistryEnabled: boolean,
) {
  return [
    { id: "general", icon: SlidersHorizontal },
    { id: "models", icon: Cpu },
    { id: "appearance", icon: Palette },
    { id: "notifications", icon: Bell },
    { id: "editor", icon: FileCode },
    { id: "git", icon: GitBranch },
    { id: "keyboard", icon: Keyboard },
    { id: "cli", icon: Terminal },
    { id: "pinned-prompts", icon: Bookmark },
    { id: "plugins", icon: Puzzle },
    ...(communityRegistryEnabled
      ? [{ id: "community", icon: Globe }]
      : []),
    ...(pluginManagementEnabled
      ? [{ id: "claude-code-plugins", icon: Puzzle }]
      : []),
    { id: "help", icon: HelpCircle },
  ] as const;
}

export function SettingsSidebar() {
  const { t } = useTranslation(["common", "settings"]);
  const settingsSection = useAppStore((s) => s.settingsSection);
  const setSettingsSection = useAppStore((s) => s.setSettingsSection);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const repositories = useAppStore((s) => s.repositories);
  const usageInsightsEnabled = useAppStore((s) => s.usageInsightsEnabled);
  const pluginManagementEnabled = useAppStore((s) => s.pluginManagementEnabled);
  const communityRegistryEnabled = useAppStore(
    (s) => s.communityRegistryEnabled,
  );

  const sectionLabel = (id: string) => {
    if (id === "general") return t("settings:nav_general");
    if (id === "models") return t("settings:nav_models");
    if (id === "appearance") return t("settings:nav_appearance");
    if (id === "notifications") return t("settings:nav_notifications");
    if (id === "editor") return t("settings:nav_editor");
    if (id === "git") return t("settings:nav_git");
    if (id === "keyboard") return t("settings:nav_keyboard");
    if (id === "cli") return t("settings:nav_cli");
    if (id === "plugins") return t("settings:nav_plugins");
    if (id === "claude-code-plugins") return t("settings:nav_claude_code_plugins");
    if (id === "community") return t("settings:nav_community");
    if (id === "pinned-prompts") return t("settings:nav_pinned_prompts");
    if (id === "help") return t("settings:nav_help");
    return id;
  };

  return (
    <div className={styles.sidebar}>
      <button className={styles.backLink} onClick={closeSettings}>
        {t("common:back_to_app")}
      </button>

      {getAppSections(pluginManagementEnabled, communityRegistryEnabled).map((s) => (
        <button
          key={s.id}
          className={
            settingsSection === s.id ? styles.navItemActive : styles.navItem
          }
          onClick={() => setSettingsSection(s.id)}
        >
          <s.icon size={14} />
          {sectionLabel(s.id)}
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
          {t("settings:nav_usage")}
        </button>
      )}

      <div className={styles.groupLabel}>{t("settings:group_more")}</div>
      <button
        className={
          settingsSection === "experimental" ? styles.navItemActive : styles.navItem
        }
        onClick={() => setSettingsSection("experimental")}
      >
        <FlaskConical size={14} />
        {t("settings:nav_experimental")}
      </button>

      <div className={styles.groupLabel}>{t("settings:group_repositories")}</div>
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
