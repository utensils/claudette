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

let hasFocusReturn = true;
let originalHasFocus: typeof document.hasFocus | undefined;

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

  hasFocusReturn = true;
  originalHasFocus = document.hasFocus.bind(document);
  document.hasFocus = () => hasFocusReturn;
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
  if (originalHasFocus) {
    document.hasFocus = originalHasFocus;
  }
});

async function setFocus(focused: boolean) {
  hasFocusReturn = focused;
  await act(async () => {
    window.dispatchEvent(new Event(focused ? "focus" : "blur"));
  });
}

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

  describe("focus-aware pausing", () => {
    it("does not fetch while the window is blurred between polls", async () => {
      useAppStore.setState({ usageInsightsEnabled: true });
      await mountHook();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);

      await setFocus(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15 * 60_000);
      });
      // Still only the initial fetch — interval should be paused.
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);
    });

    it("fetches immediately on refocus when the interval elapsed during blur", async () => {
      useAppStore.setState({ usageInsightsEnabled: true });
      await mountHook();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);

      await setFocus(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);

      await setFocus(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(2);
    });

    it("does not refetch on refocus when the interval has not yet elapsed", async () => {
      useAppStore.setState({ usageInsightsEnabled: true });
      await mountHook();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);

      await setFocus(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await setFocus(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Only 1 minute elapsed total — no extra fetch yet.
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);
    });

    it("resumes the scheduled poll after refocus", async () => {
      useAppStore.setState({ usageInsightsEnabled: true });
      await mountHook();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);

      // Blur for 1 min, then refocus.
      await setFocus(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await setFocus(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // No catch-up fetch (interval not elapsed).
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);

      // 4 more minutes (5 min total since initial fetch) → next poll fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
      });
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(2);
    });

    it("does not fetch on enable while the window is already blurred", async () => {
      hasFocusReturn = false;
      useAppStore.setState({ usageInsightsEnabled: true });
      await mountHook();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getClaudeCodeUsageMock).not.toHaveBeenCalled();

      await setFocus(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getClaudeCodeUsageMock).toHaveBeenCalledTimes(1);
    });
  });
});
