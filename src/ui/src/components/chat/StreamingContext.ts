import { createContext } from "react";

/**
 * True while the consumer subtree is being rendered as part of a live
 * typewriter stream (or its drain phase). The `code` markdown override reads
 * this to decide how to handle syntax highlighting while content is still
 * changing — the actively-updating block renders plain because its input may
 * change every RAF tick, but stable blocks (those whose source text hasn't
 * changed for STREAMING_DEBOUNCE_MS) still get highlighted mid-stream via a
 * debounced worker dispatch. Outside streaming, highlighting dispatches
 * immediately.
 */
export const StreamingContext = createContext(false);
