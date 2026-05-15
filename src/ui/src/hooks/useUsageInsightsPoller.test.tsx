// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

const getClaudeCodeUsageMock: Mock = vi.fn();
vi.mock("../services/tauri", () => ({
  getClaudeCodeUsage: () => getClaudeCodeUsageMock(),
}));

import { useUsageInsightsPoller } from "./useUsageInsightsPoller";
import { useAppStore } from "../stores/useAppStore";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function mountHook(): Promise<void> {
  function Probe() {
    useUsageInsightsPoller();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<Probe />);
  });
}

async function unmountAll(): Promise<void> {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  getClaudeCodeUsageMock.mockReset();
  getClaudeCodeUsageMock.mockResolvedValue({
    subscription_type: "pro",
    rate_limit_tier: "default_claude_pro",
    fetched_at: 0,
    usage: {
      five_hour: null,
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: null,
      extra_usage: null,
    },
  });
  useAppStore.setState({
    usageInsightsEnabled: false,
    claudeCodeUsage: null,
  });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

describe("useUsageInsightsPoller", () => {
  it("does not call getClaudeCodeUsage while disabled", async () => {
    await mountHook();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(getClaudeCodeUsageMock).not.toHaveBeenCalled();
  });

  it("fetches once immediately when enabled and writes to the store", async () => {
    await mountHook();
    await act(async () => {
      useAppStore.setState({ usageInsightsEnabled: true });
      // Flush the queued microtask from the effect's fetchOnce().
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().claudeCodeUsage).not.toBeNull();
  });

  it("polls again after the 5-minute interval", async () => {
    useAppStore.setState({ usageInsightsEnabled: true });
    await mountHook();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(2);
  });

  it("stops polling when disabled mid-flight", async () => {
    useAppStore.setState({ usageInsightsEnabled: true });
    await mountHook();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      useAppStore.setState({ usageInsightsEnabled: false });
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);
  });

  it("clears its interval on unmount", async () => {
    useAppStore.setState({ usageInsightsEnabled: true });
    await mountHook();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);

    await unmountAll();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);
  });

  it("swallows fetch errors without crashing the host", async () => {
    getClaudeCodeUsageMock.mockRejectedValueOnce(new Error("boom"));
    useAppStore.setState({ usageInsightsEnabled: true });
    await mountHook();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().claudeCodeUsage).toBeNull();
  });
});
