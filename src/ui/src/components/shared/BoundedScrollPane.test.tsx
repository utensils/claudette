// @vitest-environment happy-dom

// `BoundedScrollPane` is a thin wrapper around `usePreventScrollBounce`,
// so the bulk of the predicate coverage lives in that hook's own test
// suite. This file pins the wrapper-specific contract:
//
// 1. It renders a real `<div>` with all forwarded HTML attributes (so
//    callers can pass `className`, `aria-*`, etc.). A regression that
//    swallowed `className` would break every consumer's scroll styling.
// 2. The ref-forwarding actually exposes the inner DOM node, so
//    consumers that need direct DOM access (`useStickyScroll`, search
//    scopes) can still get it.
// 3. The hook is wired up — fires `preventDefault` on a boundary wheel.
//    Without this end-to-end check, a future refactor could decouple
//    the hook from the wrapper and silently kill the bounce-prevention.
// 4. Re-mounting the wrapper (Dashboard's render-branch swap pattern)
//    re-binds the listeners against the new container — this is the
//    actual motivating case for moving the hook into a wrapper.

import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BoundedScrollPane } from "./BoundedScrollPane";

const mountedRoots: Root[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  // happy-dom shares one document across tests; scrub anything attached.
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
  vi.restoreAllMocks();
});

/** Stub layout so `usePreventScrollBounce`'s helpers see a real
 *  scroll surface — happy-dom doesn't compute layout on its own. */
function stubLayout(
  el: HTMLElement,
  metrics: { scrollTop?: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: metrics.scrollTop ?? 0,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: metrics.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });
}

async function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  await act(async () => {
    root.render(node);
  });
  return host;
}

describe("BoundedScrollPane", () => {
  it("renders a div with forwarded className and children", async () => {
    const host = await mount(
      <BoundedScrollPane className="my-scroll" data-testid="pane">
        <span>inside</span>
      </BoundedScrollPane>,
    );
    const div = host.querySelector("div");
    expect(div).toBeTruthy();
    expect(div?.className).toBe("my-scroll");
    expect(div?.getAttribute("data-testid")).toBe("pane");
    expect(div?.textContent).toBe("inside");
  });

  it("forwards a ref to the underlying DOM node", async () => {
    const ref: { current: HTMLDivElement | null } = { current: null };
    const Consumer = () => {
      const localRef = useRef<HTMLDivElement>(null);
      // Mirror through `localRef` so we can prove the ref points at the
      // same element React renders — not a wrapper element it might have
      // sneaked in between the caller and the DOM.
      ref.current = localRef.current;
      return (
        <BoundedScrollPane
          ref={(el) => {
            localRef.current = el;
            ref.current = el;
          }}
          className="ref-target"
        />
      );
    };
    const host = await mount(<Consumer />);
    expect(ref.current).toBe(host.querySelector(".ref-target"));
  });

  it("forwards a MutableRefObject and resets it to null on unmount", async () => {
    // Object-style refs are the common idiom (`useRef<HTMLDivElement>(null)`),
    // so the wrapper must support both function refs (above) and ref objects.
    // The unmount half also pins the lifecycle contract: when the pane goes
    // away, the caller's ref clears — without this, `useStickyScroll` etc.
    // would hold a dangling node pointer after navigation.
    const refObj: { current: HTMLDivElement | null } = { current: null };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(<BoundedScrollPane ref={refObj} className="forwarded" />);
    });
    const div = host.querySelector<HTMLDivElement>(".forwarded");
    expect(refObj.current).toBe(div);

    await act(async () => {
      root.render(<></>);
    });
    expect(refObj.current).toBeNull();
  });

  it("calls preventDefault on a wheel event when the pane is at its scroll boundary", async () => {
    const host = await mount(
      <BoundedScrollPane className="pane" data-testid="pane" />,
    );
    const div = host.querySelector<HTMLDivElement>(".pane")!;
    // Same scrollHeight === clientHeight setup the hook's own tests use:
    // the pane can't scroll downward, so a downward wheel should be cancelled.
    stubLayout(div, { scrollHeight: 200, clientHeight: 200, scrollTop: 0 });

    const wheel = new WheelEvent("wheel", {
      deltaY: 10,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(wheel, "preventDefault");
    div.dispatchEvent(wheel);
    expect(preventDefault).toHaveBeenCalled();
  });

  // Dashboard's three render branches (scoped / no-workspaces / active)
  // unmount one pane and mount another when the user navigates between
  // them. Each new pane must re-bind the hook against its own DOM node —
  // the previous shared-ref-on-a-stable-element pattern in ChatPanel
  // would silently break here because the new pane's `.current` would
  // never be observed by the unmounted hook's closure. The wrapper
  // shape (one `useEffect` per mount) is what makes this work; this
  // test pins it.
  it("re-binds bounce prevention when the pane is re-mounted (branch swap)", async () => {
    // First mount: a pane that is NOT at its boundary, so the hook
    // would not cancel the wheel. The `key` props force React to treat
    // the two renders as distinct components — mirroring Dashboard's
    // render-branch swap where the scoped / no-workspaces / active
    // branches each return a different scrollBody element.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.push(root);
    await act(async () => {
      root.render(<BoundedScrollPane key="a" className="first" />);
    });
    const first = host.querySelector<HTMLDivElement>(".first")!;
    stubLayout(first, { scrollHeight: 500, clientHeight: 200, scrollTop: 100 });

    // Swap to a second pane that IS at its boundary — the differing key
    // forces React to unmount the first instance (running the hook's
    // cleanup) and mount a fresh instance bound to the new node.
    await act(async () => {
      root.render(<BoundedScrollPane key="b" className="second" />);
    });
    const second = host.querySelector<HTMLDivElement>(".second")!;
    expect(second).not.toBe(first);
    stubLayout(second, { scrollHeight: 200, clientHeight: 200, scrollTop: 0 });

    const wheel = new WheelEvent("wheel", {
      deltaY: 10,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(wheel, "preventDefault");
    second.dispatchEvent(wheel);
    // The new pane's boundary must be active. If the hook were still
    // bound to the unmounted first pane (which had headroom), this would
    // never fire.
    expect(preventDefault).toHaveBeenCalled();
  });
});
