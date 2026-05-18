import { describe, expect, it } from "vitest";

import { getAppSections } from "./SettingsSidebar";

describe("getAppSections", () => {
  it("always shows the Plugins (Claudette) section", () => {
    // Claudette's own plugin list is always visible — it's just
    // diagnostic info plus toggles, no marketplace dependency.
    expect(getAppSections().map((section) => section.id)).toContain(
      "plugins",
    );
  });

  it("shows the Claude Code Plugins section", () => {
    expect(getAppSections().map((section) => section.id)).toContain(
      "claude-code-plugins",
    );
  });

  it("shows the Community section", () => {
    expect(getAppSections().map((section) => section.id)).toContain(
      "community",
    );
  });

  it("keeps Usage out of the always-visible app sections", () => {
    expect(
      getAppSections().map((section) => section.id),
    ).not.toContain("usage");
  });

  it("always shows the Help section", () => {
    // Help is always-on (no experimental gate) — it surfaces the
    // shortcuts viewer + changelog link for any user.
    expect(getAppSections().map((s) => s.id)).toContain("help");
  });

  it("places the Automation and Editor sections between Notifications and Git", () => {
    // The Editor section is where the git-gutter base preference lives
    // — it must sit alongside the other "how the app behaves" settings,
    // not be hidden under Plugins / Experimental.
    const ids = getAppSections().map((section) => section.id);
    const automationIdx = ids.indexOf("automation");
    const editorIdx = ids.indexOf("editor");
    const notificationsIdx = ids.indexOf("notifications");
    const gitIdx = ids.indexOf("git");
    expect(automationIdx).toBeGreaterThan(-1);
    expect(editorIdx).toBeGreaterThan(-1);
    expect(notificationsIdx).toBeLessThan(automationIdx);
    expect(automationIdx).toBeLessThan(editorIdx);
    expect(editorIdx).toBeLessThan(gitIdx);
  });

  it("does not show a standalone Workspace Apps section", () => {
    expect(
      getAppSections().map((section) => section.id),
    ).not.toContain("workspace-apps");
  });
});
