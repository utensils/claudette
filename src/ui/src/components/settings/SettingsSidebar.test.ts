import { describe, expect, it } from "vitest";

import { getAppSections } from "./SettingsSidebar";

describe("getAppSections", () => {
  it("always shows the Plugins (Claudette) section", () => {
    // Claudette's own plugin list is always visible — it's just
    // diagnostic info plus toggles, no marketplace dependency.
    expect(getAppSections(false, false).map((section) => section.id)).toContain(
      "plugins",
    );
    expect(getAppSections(true, true).map((section) => section.id)).toContain(
      "plugins",
    );
  });

  it("hides the Claude Code Plugins section when plugin management is disabled", () => {
    expect(
      getAppSections(false, false).map((section) => section.id),
    ).not.toContain("claude-code-plugins");
  });

  it("shows the Claude Code Plugins section when plugin management is enabled", () => {
    expect(getAppSections(true, false).map((section) => section.id)).toContain(
      "claude-code-plugins",
    );
  });

  it("hides the Community section when the registry is disabled", () => {
    expect(
      getAppSections(false, false).map((section) => section.id),
    ).not.toContain("community");
  });

  it("shows the Community section when the registry is enabled", () => {
    expect(getAppSections(false, true).map((section) => section.id)).toContain(
      "community",
    );
  });

  it("keeps Usage out of the always-visible app sections", () => {
    expect(
      getAppSections(false, false).map((section) => section.id),
    ).not.toContain("usage");
    expect(
      getAppSections(true, true).map((section) => section.id),
    ).not.toContain("usage");
  });

  it("always shows the Help section, regardless of plugin/community flags", () => {
    // Help is always-on (no experimental gate) — it surfaces the
    // shortcuts viewer + changelog link for any user.
    expect(getAppSections(false, false).map((s) => s.id)).toContain("help");
    expect(getAppSections(true, true).map((s) => s.id)).toContain("help");
  });

  it("places the Editor section between Notifications and Git", () => {
    // The Editor section is where the git-gutter base preference lives
    // — it must sit alongside the other "how the app behaves" settings,
    // not be hidden under Plugins / Experimental.
    const ids = getAppSections(false, false).map((section) => section.id);
    const editorIdx = ids.indexOf("editor");
    const notificationsIdx = ids.indexOf("notifications");
    const gitIdx = ids.indexOf("git");
    expect(editorIdx).toBeGreaterThan(-1);
    expect(notificationsIdx).toBeLessThan(editorIdx);
    expect(editorIdx).toBeLessThan(gitIdx);
  });

  it("does not show a standalone Workspace Apps section", () => {
    expect(
      getAppSections(false, false).map((section) => section.id),
    ).not.toContain("workspace-apps");
    expect(
      getAppSections(true, true).map((section) => section.id),
    ).not.toContain("workspace-apps");
  });
});
