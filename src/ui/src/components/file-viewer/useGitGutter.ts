import { useEffect, useRef, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import { readWorkspaceFileAtHead } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { computeLineChanges, lineChangesToDecorations } from "./gitGutter";

export const GUTTER_DEBOUNCE_MS = 250;
export const GUTTER_MAX_BYTES = 1024 * 1024;
export const GUTTER_MAX_LINES = 20_000;

type Editor = Parameters<OnMount>[0];
type Monaco = Parameters<OnMount>[1];
export type DecorationsCollection = ReturnType<Editor["createDecorationsCollection"]>;
export type DecorationsCollectionRef = React.MutableRefObject<DecorationsCollection | null>;

/**
 * Wires the git gutter into a mounted Monaco editor. Fetches the file's
 * HEAD blob once per `(workspaceId, filename, diffMergeBase)`, then
 * recomputes line decorations on each buffer change (debounced 250 ms).
 *
 * The decoration collection is owned by the parent (created in
 * `handleMount` once Monaco has resolved both `editor` and `monaco`) and
 * passed in via `collectionRef`. The hook can't create it itself: a
 * `[]`-deps init effect would run before the lazy-loaded editor is
 * mounted, and a deps-tracked effect can't reliably detect mount.
 *
 * Bails out for files larger than 1 MiB or 20 000 lines — the diff cost
 * isn't worth the gutter on files that big.
 */
export function useGitGutter(
  monacoRef: React.MutableRefObject<Monaco | null>,
  collectionRef: DecorationsCollectionRef,
  workspaceId: string,
  filename: string,
  buffer: string,
) {
  // `null` = gutter unavailable (no head, fetch error, binary). Empty
  // string `""` = file untracked at HEAD; treat every line as added.
  // Lifted into state so HEAD fetch resolution triggers a re-render and
  // the buffer-effect re-runs even when the buffer hasn't changed yet
  // (the common case on file open: `currentBuffer === initialValue`).
  const [head, setHead] = useState<string | null>(null);
  // Race-safety counter for the async HEAD fetch — mirrors the
  // `loadVersionRef` pattern in FileViewer.tsx.
  const fetchVersionRef = useRef(0);

  const diffMergeBase = useAppStore((s) => s.diffMergeBase);

  // Fetch the HEAD blob whenever the file or merge-base changes. The
  // version counter discards stale responses if a newer fetch has
  // already started.
  useEffect(() => {
    const version = ++fetchVersionRef.current;
    // Reset to "loading" synchronously so the buffer-effect bails out
    // until the new fetch resolves — the cascade is intentional and
    // bounded (one extra render per file/merge-base change).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHead(null);
    collectionRef.current?.clear();

    readWorkspaceFileAtHead(workspaceId, filename)
      .then((res) => {
        if (version !== fetchVersionRef.current) return;
        if (!res.exists_at_head) {
          setHead("");
          return;
        }
        setHead(res.content);
      })
      .catch(() => {
        if (version !== fetchVersionRef.current) return;
        setHead(null);
      });
  }, [workspaceId, filename, diffMergeBase, collectionRef]);

  // Debounced recompute on every buffer or head change. Skips work when
  // the head hasn't loaded yet or the file is too big — Monaco's
  // decoration model is fast but the diff isn't free at scale.
  useEffect(() => {
    const collection = collectionRef.current;
    const monacoInstance = monacoRef.current;
    if (head === null || !collection || !monacoInstance) return;

    if (buffer.length > GUTTER_MAX_BYTES) {
      collection.clear();
      return;
    }
    if (buffer.split("\n").length > GUTTER_MAX_LINES) {
      collection.clear();
      return;
    }

    const timer = window.setTimeout(() => {
      const changes = computeLineChanges(head, buffer);
      const decos = lineChangesToDecorations(changes, monacoInstance);
      collection.set(decos);
    }, GUTTER_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [head, buffer, monacoRef, collectionRef]);
}
