import { describe, expect, it } from "vitest";
import type { DetectedApp } from "../types/apps";
import {
  appsInCategoryOrder,
  preferredPrimaryApp,
  splitMenuApps,
} from "./workspaceAppsMenu";

function app(
  id: string,
  name: string,
  category: DetectedApp["category"],
): DetectedApp {
  return { id, name, category, detected_path: `/usr/bin/${id}` };
}

const apps = [
  app("vscode", "VS Code", "editor"),
  app("zed", "Zed", "editor"),
  app("finder", "Finder", "file_manager"),
  app("ghostty", "Ghostty", "terminal"),
  app("intellij", "IntelliJ IDEA", "ide"),
];

describe("appsInCategoryOrder", () => {
  it("groups by editor → file_manager → terminal → ide, preserving order within", () => {
    const reordered = [
      app("intellij", "IntelliJ IDEA", "ide"),
      app("ghostty", "Ghostty", "terminal"),
      app("zed", "Zed", "editor"),
      app("vscode", "VS Code", "editor"),
      app("finder", "Finder", "file_manager"),
    ];
    expect(appsInCategoryOrder(reordered).map((a) => a.id)).toEqual([
      "zed",
      "vscode",
      "finder",
      "ghostty",
      "intellij",
    ]);
  });
});

describe("splitMenuApps", () => {
  it("shows everything in category order when uncurated (null)", () => {
    const { shown, more } = splitMenuApps(apps, null);
    expect(shown.map((a) => a.id)).toEqual([
      "vscode",
      "zed",
      "finder",
      "ghostty",
      "intellij",
    ]);
    expect(more).toEqual([]);
  });

  it("treats a non-array value defensively as 'show all'", () => {
    const { shown, more } = splitMenuApps(
      apps,
      "vscode" as unknown as string[],
    );
    expect(shown).toHaveLength(apps.length);
    expect(more).toEqual([]);
  });

  it("respects the curated order and folds the rest into More (category order)", () => {
    const { shown, more } = splitMenuApps(apps, ["ghostty", "vscode"]);
    expect(shown.map((a) => a.id)).toEqual(["ghostty", "vscode"]);
    expect(more.map((a) => a.id)).toEqual(["zed", "finder", "intellij"]);
  });

  it("drops stale IDs and never duplicates", () => {
    const { shown, more } = splitMenuApps(apps, [
      "missing",
      "zed",
      "zed",
      "ghostty",
    ]);
    expect(shown.map((a) => a.id)).toEqual(["zed", "ghostty"]);
    expect(more.map((a) => a.id)).toEqual(["vscode", "finder", "intellij"]);
  });

  it("allows an empty top level (everything under More)", () => {
    const { shown, more } = splitMenuApps(apps, []);
    expect(shown).toEqual([]);
    expect(more.map((a) => a.id)).toEqual([
      "vscode",
      "zed",
      "finder",
      "ghostty",
      "intellij",
    ]);
  });
});

describe("preferredPrimaryApp", () => {
  it("prefers the first shown app", () => {
    expect(
      preferredPrimaryApp(splitMenuApps(apps, ["ghostty", "vscode"]))?.id,
    ).toBe("ghostty");
  });

  it("falls back to the first More app when nothing is shown", () => {
    expect(preferredPrimaryApp(splitMenuApps(apps, []))?.id).toBe("vscode");
  });

  it("is null when there are no apps at all", () => {
    expect(preferredPrimaryApp(splitMenuApps([], null))).toBeNull();
  });
});
