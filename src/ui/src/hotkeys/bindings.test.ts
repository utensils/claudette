import { describe, expect, it } from "vitest";
import {
  buildRebindUpdates,
  eventToBinding,
  getEffectiveBindingById,
  resolveHotkeyAction,
  type KeybindingMap,
} from "./bindings";

type KeyInit = {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

function macKey(init: KeyInit): KeyboardEvent {
  return {
    type: "keydown",
    key: init.key ?? "",
    code: init.code ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  } as unknown as KeyboardEvent;
}

describe("buildRebindUpdates", () => {
  it("disables a default owner when rebinding another action to its shortcut", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "mod+d",
      {},
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": "mod+d",
      "global.toggle-right-sidebar": null,
    });
  });

  it("disables a custom owner when rebinding another action to its shortcut", () => {
    const overrides: KeybindingMap = {
      "global.toggle-fuzzy-finder": "mod+d",
      "global.toggle-right-sidebar": null,
    };

    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "mod+d",
      overrides,
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": "mod+d",
      "global.toggle-fuzzy-finder": null,
    });
  });

  it("does not re-disable actions that are already disabled", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "mod+d",
      { "global.toggle-right-sidebar": null },
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": "mod+d",
    });
  });

  it("does not attempt to unbind fixed shortcuts", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "escape",
      {},
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": "escape",
    });
  });

  it("does not look for conflicts when disabling an action", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      null,
      { "global.toggle-fuzzy-finder": "mod+b" },
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": null,
    });
  });

  it("keeps same shortcut bindings in different scopes", () => {
    const updates = buildRebindUpdates(
      "global.cycle-workspace-prev",
      "mod+shift+code:BracketLeft",
      {},
      "mac",
    );

    expect(updates).toEqual({
      "global.cycle-workspace-prev": "mod+shift+code:BracketLeft",
    });
  });
});

describe("resolveHotkeyAction with conflict updates", () => {
  it("routes the duplicated shortcut to the new owner after applying updates", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "mod+d",
      {},
      "mac",
    );

    expect(
      resolveHotkeyAction(
        macKey({ key: "d", metaKey: true }),
        "global",
        updates,
        "mac",
      ),
    ).toBe("global.toggle-sidebar");
    expect(getEffectiveBindingById("global.toggle-right-sidebar", updates, "mac"))
      .toBeNull();
  });
});

describe("eventToBinding", () => {
  it("captures platform mod only for the active platform", () => {
    expect(eventToBinding(macKey({ key: "d", metaKey: true }), "key", "mac"))
      .toBe("mod+d");
    expect(eventToBinding(macKey({ key: "d", ctrlKey: true }), "key", "mac"))
      .toBeNull();
    expect(eventToBinding(macKey({ key: "d", ctrlKey: true }), "key", "linux"))
      .toBe("mod+d");
    expect(eventToBinding(macKey({ key: "d", metaKey: true }), "key", "linux"))
      .toBeNull();
  });
});
