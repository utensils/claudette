// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repository } from "../../types/repository";
import { WelcomeEmptyState } from "./WelcomeEmptyState";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "r1",
    path: "/Users/me/code/r1",
    name: "r1",
    path_slug: "r1",
    icon: null,
    created_at: "2026-01-01T00:00:00Z",
    setup_script: null,
    custom_instructions: null,
    sort_order: 0,
    branch_rename_preferences: null,
    setup_script_auto_run: false,
    archive_script: null,
    archive_script_auto_run: false,
    base_branch: null,
    default_remote: null,
    path_valid: true,
    required_inputs: null,
    remote_connection_id: null,
    ...overrides,
  };
}

interface RenderProps {
  repositories: Repository[];
  recentRepoIds?: string[];
  onCreateWorkspace?: (repoId: string) => void;
  onAddRepository?: () => void;
  creating?: boolean;
}

async function renderWelcome(props: RenderProps): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(
      <WelcomeEmptyState
        repositories={props.repositories}
        recentRepoIds={props.recentRepoIds ?? []}
        onCreateWorkspace={props.onCreateWorkspace ?? (() => {})}
        onAddRepository={props.onAddRepository ?? (() => {})}
        creating={props.creating}
      />,
    );
  });
  return container;
}

describe("WelcomeEmptyState", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    for (const root of mountedRoots.splice(0).reverse()) {
      await act(async () => {
        root.unmount();
      });
    }
    for (const container of mountedContainers.splice(0)) {
      container.remove();
    }
  });

  it("renders the add-repo CTA as the only action when no repositories exist", async () => {
    const onAdd = vi.fn();
    const onCreate = vi.fn();
    const container = await renderWelcome({
      repositories: [],
      onAddRepository: onAdd,
      onCreateWorkspace: onCreate,
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    // No suggested-project chip, no "Create Workspace" button — just the
    // primary "Add Your First Repository…" CTA.
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain("Add Your First Repository");

    await act(async () => {
      buttons[0].click();
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("uses the only repository as the suggested target when one exists", async () => {
    const onCreate = vi.fn();
    const repos = [makeRepo({ id: "solo", name: "solo", path: "/p/solo" })];
    const container = await renderWelcome({
      repositories: repos,
      onCreateWorkspace: onCreate,
    });

    // Project list ("Your Projects") only renders for >1 repo — single-repo
    // case keeps the focus on the suggested-project chip + primary CTA.
    expect(container.textContent).not.toContain("Your Projects");
    expect(container.textContent).toContain("solo");
    expect(container.textContent).toContain("/p/solo");

    // Both the project chip and the primary "Create Workspace" button
    // dispatch onCreateWorkspace with the suggested repo's id.
    const createButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("Create Workspace"));
    expect(createButton).toBeDefined();
    await act(async () => {
      createButton!.click();
    });
    expect(onCreate).toHaveBeenCalledWith("solo");
  });

  it("ranks the suggested repo by recency and lists all projects in order", async () => {
    const onCreate = vi.fn();
    const repos = [
      makeRepo({ id: "alpha", name: "alpha", path: "/p/alpha", sort_order: 0 }),
      makeRepo({ id: "bravo", name: "bravo", path: "/p/bravo", sort_order: 1 }),
      makeRepo({ id: "delta", name: "delta", path: "/p/delta", sort_order: 2 }),
    ];
    // bravo is most recently used, even though alpha sorts first.
    const container = await renderWelcome({
      repositories: repos,
      recentRepoIds: ["bravo", "alpha"],
      onCreateWorkspace: onCreate,
    });

    // The active-project chip should reflect "bravo" — the most recent.
    const chip = container.querySelector("button[title='Create a workspace in bravo']");
    expect(chip).toBeTruthy();

    // Project list rows render in recency order (bravo, alpha) followed by
    // delta (no recency → falls back to sort_order). The row body now uses
    // a two-line layout (name + path), so we read each row's <button> title
    // attribute (`Create a workspace in <name>`) to recover the project
    // name without depending on the inner DOM shape.
    const rowButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("ul li button"),
    );
    const rowNames = rowButtons.map((b) =>
      (b.getAttribute("title") ?? "").replace("Create a workspace in ", ""),
    );
    expect(rowNames).toEqual(["bravo", "alpha", "delta"]);

    // Clicking a row dispatches that row's repo id, not the suggested one.
    const deltaRow = rowButtons.find((b) => b.textContent?.includes("delta"));
    await act(async () => {
      deltaRow!.click();
    });
    expect(onCreate).toHaveBeenLastCalledWith("delta");
  });

  it("disables actions while a creation is already in flight", async () => {
    const onCreate = vi.fn();
    const repos = [makeRepo({ id: "solo", name: "solo" })];
    const container = await renderWelcome({
      repositories: repos,
      onCreateWorkspace: onCreate,
      creating: true,
    });

    const createButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("Create Workspace")) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);

    // Add-repo stays clickable so the user can still escape into the modal
    // even while a create is pending.
    const addButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.includes("Add Repository")) as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
  });

  it("flags repos whose path is no longer valid", async () => {
    const repos = [
      makeRepo({ id: "good", name: "good" }),
      makeRepo({ id: "bad", name: "bad", path_valid: false, sort_order: 1 }),
    ];
    const container = await renderWelcome({
      repositories: repos,
    });

    const badRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>("ul li button"),
    ).find((b) => b.textContent?.includes("bad"));
    expect(badRow?.textContent).toContain("missing");

    const goodRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>("ul li button"),
    ).find((b) => b.textContent?.includes("good"));
    expect(goodRow?.textContent).not.toContain("missing");
  });
});
