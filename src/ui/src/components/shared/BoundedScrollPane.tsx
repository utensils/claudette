import { forwardRef, useImperativeHandle, useRef, type HTMLAttributes } from "react";
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
  // `useImperativeHandle` lets callers pass a normal ref while we keep our
  // own internal ref for the hook. Without this, consumers would have to
  // choose between getting the DOM node and getting the bounce-prevention.
  useImperativeHandle(forwardedRef, () => innerRef.current as HTMLDivElement);
  return (
    <div ref={innerRef} {...rest}>
      {children}
    </div>
  );
});
