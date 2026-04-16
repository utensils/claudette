import { describe, expect, it } from "vitest";

import type { SlashCommand } from "../../services/tauri";
import { filterSlashCommands } from "./SlashCommandPicker";

function cmd(partial: Partial<SlashCommand> & { name: string }): SlashCommand {
  return {
    description: partial.description ?? "",
    source: partial.source ?? "builtin",
    aliases: partial.aliases,
    argument_hint: partial.argument_hint,
    kind: partial.kind,
    ...partial,
  };
}

describe("filterSlashCommands", () => {
  const commands: SlashCommand[] = [
    cmd({ name: "plugin", aliases: ["plugins"], kind: "settings_route" }),
    cmd({ name: "marketplace", kind: "settings_route" }),
    cmd({ name: "commit", source: "user" }),
    cmd({ name: "deploy", source: "project" }),
    cmd({ name: "cmux-browser", source: "plugin" }),
  ];

  it("matches by substring on the canonical name", () => {
    expect(filterSlashCommands(commands, "plug").map((c) => c.name)).toEqual([
      "plugin",
    ]);
  });

  it("matches by alias so /plugins surfaces the plugin card", () => {
    expect(filterSlashCommands(commands, "plugins").map((c) => c.name)).toEqual([
      "plugin",
    ]);
  });

  it("returns every command for an empty query", () => {
    expect(filterSlashCommands(commands, "").length).toBe(commands.length);
  });

  it("returns nothing for an unrelated token", () => {
    expect(filterSlashCommands(commands, "xyzzy")).toEqual([]);
  });

  it("is case-insensitive on aliases", () => {
    expect(
      filterSlashCommands(commands, "PLUGINS").map((c) => c.name),
    ).toEqual(["plugin"]);
  });

  it("tolerates commands without the optional aliases field", () => {
    const legacy: SlashCommand[] = [
      { name: "legacy", description: "", source: "user" },
    ];
    expect(filterSlashCommands(legacy, "leg").map((c) => c.name)).toEqual([
      "legacy",
    ]);
  });
});
