import { createContext, type MutableRefObject } from "react";

/** Context to pass sticky-scroll handler into streaming sub-components. */
export const ScrollContext = createContext<{
  handleContentChanged: () => void;
  suppressNextAutoScrollRef: MutableRefObject<boolean>;
}>({
  handleContentChanged: () => {},
  suppressNextAutoScrollRef: { current: false },
});
