// @vitest-environment happy-dom

import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlashCommand } from "../services/tauri";
import { useSlashPicker } from "./useSlashPicker";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

type Api = ReturnType<typeof useSlashPicker>;

interface HarnessProps {
  chatInput: string;
  composerMode: "prompt" | "shell";
  slashCommands: SlashCommand[];
  onSelectCommand: (cmd: SlashCommand, send: string) => void;
  onAutocomplete: (replacement: string) => void;
  onReady: (api: Api) => void;
}

function Harness({
  chatInput,
  composerMode,
  slashCommands,
  onSelectCommand,
  onAutocomplete,
  onReady,
}: HarnessProps) {
  const api = useSlashPicker({
    chatInput,
    composerMode,
    slashCommands,
    onSelectCommand,
    onAutocomplete,
  });
  useEffect(() => {
    onReady(api);
  });
  return null;
}

async function render(node: ReactNode): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(node);
  });
}

async function rerender(node: ReactNode): Promise<void> {
  const root = mountedRoots[mountedRoots.length - 1];
  await act(async () => {
    root.render(node);
  });
}

afterEach(() => {
  while (mountedRoots.length) {
    const root = mountedRoots.pop()!;
    act(() => root.unmount());
  }
  while (mountedContainers.length) {
    const container = mountedContainers.pop()!;
    container.remove();
  }
});

function makeCmd(name: string, kind?: SlashCommand["kind"]): SlashCommand {
  return { name, kind, description: "" } as SlashCommand;
}

function keyEvent(key: string, opts: { shiftKey?: boolean } = {}): React.KeyboardEvent {
  return { key, shiftKey: opts.shiftKey ?? false } as React.KeyboardEvent;
}

const COMMANDS: SlashCommand[] = [
  makeCmd("plugin"),
  makeCmd("plan"),
  makeCmd("model"),
];

describe("useSlashPicker", () => {
  it("is closed when input does not start with /", async () => {
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="hello"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={() => undefined}
        onAutocomplete={() => undefined}
        onReady={(a) => (api = a)}
      />,
    );
    expect(api!.showSlashPicker).toBe(false);
    expect(api!.slashResults).toEqual([]);
  });

  it("is closed when composerMode is shell, even with a slash input", async () => {
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="/plan"
        composerMode="shell"
        slashCommands={COMMANDS}
        onSelectCommand={() => undefined}
        onAutocomplete={() => undefined}
        onReady={(a) => (api = a)}
      />,
    );
    expect(api!.showSlashPicker).toBe(false);
  });

  it("opens with filtered results when input is /<prefix>", async () => {
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="/pl"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={() => undefined}
        onAutocomplete={() => undefined}
        onReady={(a) => (api = a)}
      />,
    );
    expect(api!.showSlashPicker).toBe(true);
    expect(api!.slashResults.map((c) => c.name)).toEqual(["plugin", "plan"]);
    expect(api!.selectedIndex).toBe(0);
  });

  it("ArrowDown / ArrowUp navigate within bounds; out-of-bounds keys not consumed", async () => {
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="/pl"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={() => undefined}
        onAutocomplete={() => undefined}
        onReady={(a) => (api = a)}
      />,
    );
    await act(async () => {
      expect(api!.handleKeyDown(keyEvent("ArrowDown"))).toBe(true);
    });
    expect(api!.selectedIndex).toBe(1);

    await act(async () => {
      // Already at last index — clamps, no overflow.
      expect(api!.handleKeyDown(keyEvent("ArrowDown"))).toBe(true);
    });
    expect(api!.selectedIndex).toBe(1);

    await act(async () => {
      expect(api!.handleKeyDown(keyEvent("ArrowUp"))).toBe(true);
    });
    expect(api!.selectedIndex).toBe(0);

    await act(async () => {
      // Already at 0 — clamps, no negative.
      expect(api!.handleKeyDown(keyEvent("ArrowUp"))).toBe(true);
    });
    expect(api!.selectedIndex).toBe(0);

    await act(async () => {
      // Unrelated key not consumed.
      expect(api!.handleKeyDown(keyEvent("a"))).toBe(false);
    });
  });

  it("Enter sends canonical /<name> when no args typed", async () => {
    const onSelect = vi.fn();
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="/pl"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={onSelect}
        onAutocomplete={() => undefined}
        onReady={(a) => (api = a)}
      />,
    );
    await act(async () => {
      expect(api!.handleKeyDown(keyEvent("Enter"))).toBe(true);
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("plugin");
    expect(onSelect.mock.calls[0][1]).toBe("/plugin");
  });

  it("Enter sends the user's typed string when args are present", async () => {
    const onSelect = vi.fn();
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="/plugin install foo"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={onSelect}
        onAutocomplete={() => undefined}
        onReady={(a) => (api = a)}
      />,
    );
    await act(async () => {
      expect(api!.handleKeyDown(keyEvent("Enter"))).toBe(true);
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][1]).toBe("/plugin install foo");
  });

  it("Shift+Enter is not consumed (preserves newline behavior)", async () => {
    const onSelect = vi.fn();
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="/pl"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={onSelect}
        onAutocomplete={() => undefined}
        onReady={(a) => (api = a)}
      />,
    );
    await act(async () => {
      expect(api!.handleKeyDown(keyEvent("Enter", { shiftKey: true }))).toBe(false);
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Tab autocompletes to /<name>  and dismisses", async () => {
    const onAutocomplete = vi.fn();
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="/pl"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={() => undefined}
        onAutocomplete={onAutocomplete}
        onReady={(a) => (api = a)}
      />,
    );
    await act(async () => {
      expect(api!.handleKeyDown(keyEvent("Tab"))).toBe(true);
    });
    expect(onAutocomplete).toHaveBeenCalledWith("/plugin ");
    // Picker dismissed even though slashQueryToken still matches.
    expect(api!.showSlashPicker).toBe(false);
  });

  it("Shift+Tab is not consumed", async () => {
    const onAutocomplete = vi.fn();
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="/pl"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={() => undefined}
        onAutocomplete={onAutocomplete}
        onReady={(a) => (api = a)}
      />,
    );
    await act(async () => {
      expect(api!.handleKeyDown(keyEvent("Tab", { shiftKey: true }))).toBe(false);
    });
    expect(onAutocomplete).not.toHaveBeenCalled();
  });

  it("Escape dismisses without invoking any selection callback", async () => {
    const onSelect = vi.fn();
    const onAutocomplete = vi.fn();
    let api: Api | undefined;
    await render(
      <Harness
        chatInput="/pl"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={onSelect}
        onAutocomplete={onAutocomplete}
        onReady={(a) => (api = a)}
      />,
    );
    await act(async () => {
      expect(api!.handleKeyDown(keyEvent("Escape"))).toBe(true);
    });
    expect(api!.showSlashPicker).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onAutocomplete).not.toHaveBeenCalled();
  });

  it("changing the slash token resets index and clears dismiss", async () => {
    let api: Api | undefined;
    const onReady = (a: Api) => (api = a);
    await render(
      <Harness
        chatInput="/pl"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={() => undefined}
        onAutocomplete={() => undefined}
        onReady={onReady}
      />,
    );
    // Advance + dismiss.
    await act(async () => {
      api!.handleKeyDown(keyEvent("ArrowDown"));
    });
    await act(async () => {
      api!.handleKeyDown(keyEvent("Escape"));
    });
    expect(api!.showSlashPicker).toBe(false);
    expect(api!.selectedIndex).toBe(1);

    // Rerender with a new token — should reset both pieces of state.
    await rerender(
      <Harness
        chatInput="/mo"
        composerMode="prompt"
        slashCommands={COMMANDS}
        onSelectCommand={() => undefined}
        onAutocomplete={() => undefined}
        onReady={onReady}
      />,
    );
    expect(api!.showSlashPicker).toBe(true);
    expect(api!.selectedIndex).toBe(0);
  });
});
