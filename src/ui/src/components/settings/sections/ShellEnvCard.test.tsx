// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "../../../stores/useAppStore";

// Mock tauri-related services so the store's refreshShellEnv never hits the
// real IPC layer during component tests.
vi.mock("../../../services/env", () => ({
  listShellEnv: vi.fn().mockResolvedValue({
    captured_at_ms: 0,
    forwarded: [],
    inherited: [],
    denied_built_in: [],
    denied_user: [],
    disabled: false,
    source_files: [],
    error: null,
  }),
  setShellEnvDenylist: vi.fn().mockResolvedValue(undefined),
  setShellEnvDisabled: vi.fn().mockResolvedValue(undefined),
  reloadShellEnv: vi.fn().mockResolvedValue(undefined),
}));

import { ShellEnvCard } from "./ShellEnvCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function renderCard(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<ShellEnvCard />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("ShellEnvCard", () => {
  beforeEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    // Stub refreshShellEnv so useEffect in ShellEnvCard doesn't overwrite
    // the test-controlled shellEnv state when the component mounts.
    useAppStore.setState({
      refreshShellEnv: vi.fn().mockResolvedValue(undefined),
      reloadShellEnv: vi.fn().mockResolvedValue(undefined),
      setShellEnvDenylist: vi.fn().mockResolvedValue(undefined),
      setShellEnvDisabled: vi.fn().mockResolvedValue(undefined),
      shellEnv: {
        captured_at_ms: Date.now() - 60_000,
        forwarded: [
          { name: "JWT_CLIENT_ID", value: "abc123", denied: false },
          { name: "GOPATH", value: "/Users/k/go", denied: false },
        ],
        inherited: [],
        denied_built_in: ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES"],
        denied_user: [],
        disabled: false,
        source_files: ["/Users/k/.zshrc", "/Users/k/.zprofile"],
        error: null,
      },
    });
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

  it("renders captured var names and masks values", async () => {
    const container = await renderCard();
    expect(container.textContent).toContain("JWT_CLIENT_ID");
    expect(container.textContent).not.toContain("abc123");
    // Masked values are present (the ● char appears in the rendered output)
    expect(container.textContent ?? "").toMatch(/●/);
  });

  it("show button reveals the value", async () => {
    const container = await renderCard();
    const showBtns = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((b) => b.textContent?.toLowerCase().includes("show"));
    expect(showBtns.length).toBeGreaterThan(0);
    await act(async () => {
      showBtns[0].click();
    });
    expect(container.textContent).toContain("abc123");
  });

  it("reload triggers reloadShellEnv action", async () => {
    const reloadSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ reloadShellEnv: reloadSpy });
    const container = await renderCard();
    const reloadBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.toLowerCase().includes("reload"));
    expect(reloadBtn).toBeDefined();
    await act(async () => {
      reloadBtn!.click();
    });
    expect(reloadSpy).toHaveBeenCalled();
  });

  it("renders an error message when shellEnv.error is set", async () => {
    useAppStore.setState({
      refreshShellEnv: vi.fn().mockResolvedValue(undefined),
      shellEnv: {
        captured_at_ms: 0,
        forwarded: [],
        inherited: [],
        denied_built_in: [],
        denied_user: [],
        disabled: false,
        source_files: [],
        error: "Shell environment probe has not completed yet.",
      },
    });
    const container = await renderCard();
    expect(container.textContent).toContain(
      "Shell environment probe has not completed",
    );
  });

  it("renders inherited vars in a separate section", async () => {
    useAppStore.setState({
      refreshShellEnv: vi.fn().mockResolvedValue(undefined),
      reloadShellEnv: vi.fn().mockResolvedValue(undefined),
      setShellEnvDenylist: vi.fn().mockResolvedValue(undefined),
      setShellEnvDisabled: vi.fn().mockResolvedValue(undefined),
      shellEnv: {
        captured_at_ms: Date.now(),
        forwarded: [{ name: "JWT_CLIENT_ID", value: "abc", denied: false }],
        inherited: [{ name: "HOME", value: "/Users/k", denied: false }],
        denied_built_in: [],
        denied_user: [],
        disabled: false,
        source_files: ["/Users/k/.zshrc"],
        error: null,
      },
    });
    const container = await renderCard();
    expect(container.textContent).toContain("JWT_CLIENT_ID");
    expect(container.textContent).toContain("HOME");
    expect(container.textContent).toMatch(/1 variables inherited/i);
  });

  it("hydrates the deny textarea from denied_user on snapshot load", async () => {
    useAppStore.setState({
      refreshShellEnv: vi.fn().mockResolvedValue(undefined),
      reloadShellEnv: vi.fn().mockResolvedValue(undefined),
      setShellEnvDenylist: vi.fn().mockResolvedValue(undefined),
      setShellEnvDisabled: vi.fn().mockResolvedValue(undefined),
      shellEnv: {
        captured_at_ms: Date.now(),
        forwarded: [],
        inherited: [],
        denied_built_in: [],
        denied_user: ["AWS_*", "STRIPE_*"],
        disabled: false,
        source_files: [],
        error: null,
      },
    });
    const container = await renderCard();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    // Hydration runs via useEffect; flush pending microtasks
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(textarea!.value).toBe("AWS_*\nSTRIPE_*");
  });

  it("does not call setShellEnvDenylist on focus+blur without changes", async () => {
    const setDenylistSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      refreshShellEnv: vi.fn().mockResolvedValue(undefined),
      reloadShellEnv: vi.fn().mockResolvedValue(undefined),
      setShellEnvDenylist: setDenylistSpy,
      setShellEnvDisabled: vi.fn().mockResolvedValue(undefined),
      shellEnv: {
        captured_at_ms: Date.now(),
        forwarded: [],
        inherited: [],
        denied_built_in: [],
        denied_user: ["AWS_*"],
        disabled: false,
        source_files: [],
        error: null,
      },
    });
    const container = await renderCard();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    // Flush hydration effect
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(textarea!.value).toBe("AWS_*");

    // Focus then blur without changing value
    await act(async () => {
      textarea!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      textarea!.dispatchEvent(new FocusEvent("focus"));
      textarea!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(setDenylistSpy).not.toHaveBeenCalled();
  });

  it("calls setShellEnvDenylist with parsed array when draft diverges from denied_user on blur", async () => {
    // NOTE: triggering React's synthetic onChange on a controlled textarea
    // without @testing-library is unreliable in happy-dom. We test the blur
    // guard via a scenario where denyDraft legitimately diverges from
    // denied_user:
    //   1. Render with denied_user = ["AWS_*", "STRIPE_*"]
    //      → hydration sets denyDraft = "AWS_*\nSTRIPE_*"
    //   2. User focuses the textarea (focus-gate locks)
    //   3. Backend/store updates denied_user = [] while textarea is focused
    //      → hydration is gated, so denyDraft stays "AWS_*\nSTRIPE_*"
    //   4. User blurs → guard sees draft ["AWS_*","STRIPE_*"] ≠ [] → calls
    //      setShellEnvDenylist(["AWS_*","STRIPE_*"])
    const setDenylistSpy = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({
      refreshShellEnv: vi.fn().mockResolvedValue(undefined),
      reloadShellEnv: vi.fn().mockResolvedValue(undefined),
      setShellEnvDenylist: setDenylistSpy,
      setShellEnvDisabled: vi.fn().mockResolvedValue(undefined),
      shellEnv: {
        captured_at_ms: Date.now(),
        forwarded: [],
        inherited: [],
        denied_built_in: [],
        denied_user: ["AWS_*", "STRIPE_*"],
        disabled: false,
        source_files: [],
        error: null,
      },
    });
    const container = await renderCard();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    // Flush hydration effect
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(textarea!.value).toBe("AWS_*\nSTRIPE_*");

    // Focus locks the hydration gate
    await act(async () => {
      textarea!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      textarea!.dispatchEvent(new FocusEvent("focus"));
    });

    // Backend update clears denied_user while textarea is focused
    await act(async () => {
      useAppStore.setState((state) => ({
        shellEnv: state.shellEnv
          ? { ...state.shellEnv, denied_user: [] }
          : state.shellEnv,
      }));
    });

    // Blur: denyDraft = "AWS_*\nSTRIPE_*", denied_user = [] — they differ
    await act(async () => {
      textarea!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(setDenylistSpy).toHaveBeenCalledWith(["AWS_*", "STRIPE_*"]);
  });
});
