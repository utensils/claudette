import { describe, expect, it } from "vitest";

import { getAppSections } from "./SettingsSidebar";

describe("getAppSections", () => {
  it("always shows the Plugins (Claudette) section", () => {
    // Claudette's own plugin list is always visible — it's just
    // diagnostic info plus toggles, no marketplace dependency.
    expect(getAppSections(false).map((section) => section.id)).toContain(
      "plugins",
    );
    expect(getAppSections(true).map((section) => section.id)).toContain(
      "plugins",
    );
  });

  it("hides the Claude Code Plugins section when plugin management is disabled", () => {
    expect(getAppSections(false).map((section) => section.id)).not.toContain(
      "claude-code-plugins",
    );
  });

  it("shows the Claude Code Plugins section when plugin management is enabled", () => {
    expect(getAppSections(true).map((section) => section.id)).toContain(
      "claude-code-plugins",
    );
  });
});
