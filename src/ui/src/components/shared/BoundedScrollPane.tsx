import {
  forwardRef,
  useCallback,
  useRef,
  type HTMLAttributes,
  type MutableRefObject,
  type Ref,
} from "react";
import { usePreventScrollBounce } from "../../hooks/usePreventScrollBounce";

/**
 * A vertically-scrolling `<div>` that does not elastic-bounce at its edges.
 *
 * Wraps `usePreventScrollBounce` so callers don't have to manage the ref +
 * effect plumbing themselves. Use this anywhere a pane has its own scroll
 * surface (Dashboard, settings tabs, list popovers, etc.) and you'd
 * otherwise have to remember to call the hook by hand — the previous
 * pattern (`ChatPanel.tsx`) used a single stable `.messages` ref because
 * its scroll surface is always mounted, but panes that swap render
 * branches (like Dashboard's scoped / empty / active variants) need each
 * branch's scroll container to own its own ref so the hook's effect can
 * cleanly bind on mount and tear down on unmount when branches swap.
 *
 * Forwards a ref to the underlying `<div>` so callers retain the escape
 * hatch — `useStickyScroll`, search highlight scopes, and friends still
 * need direct DOM access for their own bookkeeping.
 *
 * Pair this with `overscroll-behavior-y: none` on the container's CSS
 * class — the JS hook handles WKWebView's elastic gesture (which the CSS
 * property doesn't reliably suppress), and the CSS property handles the
 * trackpad-flick edge case before the wheel listener can intercept.
 */
export const BoundedScrollPane = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function BoundedScrollPane({ children, ...rest }, forwardedRef) {
  const innerRef = useRef<HTMLDivElement>(null);
  usePreventScrollBounce(innerRef);
  // Fork the ref between our internal one (which the hook reads) and the
  // forwarded one (which the caller may want for `useStickyScroll`, search
  // scopes, etc.). React invokes a callback ref during commit, both on
  // mount (with the node) and unmount (with `null`), so the forwarded
  // ref's `.current` always stays in lockstep with our internal one —
  // including the unmount case, which an earlier `useImperativeHandle`
  // approach would have masked with a cast.
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        (forwardedRef as MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [forwardedRef],
  ) satisfies Ref<HTMLDivElement>;
  return (
    <div ref={setRefs} {...rest}>
      {children}
    </div>
  );
});
