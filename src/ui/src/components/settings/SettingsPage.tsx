import { useAppStore } from "../../stores/useAppStore";
import { SettingsSidebar } from "./SettingsSidebar";
import { GeneralSettings } from "./sections/GeneralSettings";
import { ModelSettings } from "./sections/ModelSettings";
import { AppearanceSettings } from "./sections/AppearanceSettings";
import { NotificationsSettings } from "./sections/NotificationsSettings";
import { GitSettings } from "./sections/GitSettings";
import { RepoSettings } from "./sections/RepoSettings";
import { PlaceholderSettings } from "./sections/PlaceholderSettings";
import styles from "./Settings.module.css";

function SectionContent({ section }: { section: string | null }) {
  if (!section || section === "general") return <GeneralSettings />;
  if (section === "models") return <ModelSettings />;
  if (section === "appearance") return <AppearanceSettings />;
  if (section === "notifications") return <NotificationsSettings />;
  if (section === "git") return <GitSettings />;
  if (section === "experimental")
    return <PlaceholderSettings title="Experimental" />;
  if (section.startsWith("repo:"))
    return <RepoSettings repoId={section.slice(5)} />;
  return <GeneralSettings />;
}

export function SettingsPage() {
  const settingsSection = useAppStore((s) => s.settingsSection);

  return (
    <div className={styles.container}>
      <div className={styles.dragRegion} data-tauri-drag-region />
      <SettingsSidebar />
      <div className={styles.content}>
        <SectionContent section={settingsSection} />
      </div>
    </div>
  );
}
