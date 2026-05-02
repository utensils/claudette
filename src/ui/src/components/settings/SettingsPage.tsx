import { lazy, Suspense } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { SettingsSidebar } from "./SettingsSidebar";
import styles from "./Settings.module.css";

// Each section is split into its own chunk so cold start doesn't pay for
// settings panels the user may never open. The first navigation into a section
// fetches its chunk; subsequent navigations are cache hits.
const GeneralSettings = lazy(() =>
  import("./sections/GeneralSettings").then((m) => ({ default: m.GeneralSettings })),
);
const ModelSettings = lazy(() =>
  import("./sections/ModelSettings").then((m) => ({ default: m.ModelSettings })),
);
const AppearanceSettings = lazy(() =>
  import("./sections/AppearanceSettings").then((m) => ({ default: m.AppearanceSettings })),
);
const NotificationsSettings = lazy(() =>
  import("./sections/NotificationsSettings").then((m) => ({ default: m.NotificationsSettings })),
);
const GitSettings = lazy(() =>
  import("./sections/GitSettings").then((m) => ({ default: m.GitSettings })),
);
const RepoSettings = lazy(() =>
  import("./sections/RepoSettings").then((m) => ({ default: m.RepoSettings })),
);
const ExperimentalSettings = lazy(() =>
  import("./sections/ExperimentalSettings").then((m) => ({ default: m.ExperimentalSettings })),
);
const UsageSettings = lazy(() =>
  import("./sections/UsageSettings").then((m) => ({ default: m.UsageSettings })),
);
const PluginsSettings = lazy(() =>
  import("./sections/PluginsSettings").then((m) => ({ default: m.PluginsSettings })),
);
const ClaudeCodePluginsSettings = lazy(() =>
  import("./sections/ClaudeCodePluginsSettings").then((m) => ({
    default: m.ClaudeCodePluginsSettings,
  })),
);
const CommunitySettings = lazy(() =>
  import("./sections/CommunitySettings").then((m) => ({
    default: m.CommunitySettings,
  })),
);
const PinnedPromptsSettings = lazy(() =>
  import("./sections/PinnedPromptsSettings").then((m) => ({
    default: m.PinnedPromptsSettings,
  })),
);
const CollaborationSettings = lazy(() =>
  import("./sections/CollaborationSettings").then((m) => ({
    default: m.CollaborationSettings,
  })),
);

function SectionContent({ section }: { section: string | null }) {
  const pluginManagementEnabled = useAppStore((s) => s.pluginManagementEnabled);
  const communityRegistryEnabled = useAppStore(
    (s) => s.communityRegistryEnabled,
  );
  if (!section || section === "general") return <GeneralSettings />;
  if (section === "models") return <ModelSettings />;
  if (section === "usage") return <UsageSettings />;
  if (section === "appearance") return <AppearanceSettings />;
  if (section === "notifications") return <NotificationsSettings />;
  if (section === "git") return <GitSettings />;
  if (section === "collaboration") return <CollaborationSettings />;
  if (section === "pinned-prompts") return <PinnedPromptsSettings />;
  if (section === "plugins") return <PluginsSettings />;
  if (section === "claude-code-plugins") {
    return pluginManagementEnabled ? (
      <ClaudeCodePluginsSettings />
    ) : (
      <ExperimentalSettings />
    );
  }
  if (section === "community") {
    return communityRegistryEnabled ? (
      <CommunitySettings />
    ) : (
      <ExperimentalSettings />
    );
  }
  if (section === "experimental") return <ExperimentalSettings />;
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
        <Suspense
          fallback={
            <div
              role="status"
              aria-live="polite"
              aria-busy="true"
              style={{ padding: "1rem", color: "var(--text-dim)" }}
            >
              Loading settings…
            </div>
          }
        >
          <SectionContent section={settingsSection} />
        </Suspense>
      </div>
    </div>
  );
}
