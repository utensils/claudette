// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrottledText } from "./useThrottledText";

let seen: string[] = [];
function Probe(props: { text: string; enabled?: boolean }) {
  const value = useThrottledText(props.text, {
    intervalMs: 100,
    minLength: 3,
    enabled: props.enabled,
  });
  seen.push(value);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  seen = [];
});
afterEach(() => vi.useRealTimers());

describe("useThrottledText", () => {
  it("passes short text straight through", async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe text="ab" />));
    expect(seen.at(-1)).toBe("ab");
    root.unmount();
  });

  it("throttles long text and delivers the latest value on the trailing edge", async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe text="abcd" />));
    expect(seen.at(-1)).toBe("abcd");
    await act(async () => root.render(<Probe text="abcde" />));
    await act(async () => root.render(<Probe text="abcdef" />));
    // Inside the window: still showing the previously published value.
    expect(seen.at(-1)).toBe("abcd");
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(seen.at(-1)).toBe("abcdef");
    root.unmount();
  });

  it("passes through when disabled", async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe text="abcd" enabled={false} />));
    await act(async () => root.render(<Probe text="abcdefg" enabled={false} />));
    expect(seen.at(-1)).toBe("abcdefg");
    root.unmount();
  });
});
