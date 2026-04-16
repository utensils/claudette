import { describe, expect, it } from "vitest";

import { getAppSections } from "./SettingsSidebar";

describe("getAppSections", () => {
  it("hides the plugins section when plugin management is disabled", () => {
    expect(getAppSections(false).map((section) => section.id)).not.toContain("plugins");
  });

  it("shows the plugins section when plugin management is enabled", () => {
    expect(getAppSections(true).map((section) => section.id)).toContain("plugins");
  });
});
