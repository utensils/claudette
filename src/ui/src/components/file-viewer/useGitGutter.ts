import { useEffect, useRef, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import {
  readWorkspaceFileAtRevision,
  computeWorkspaceMergeBase,
} from "../../services/tauri";
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
 * Given the current setting and the cached merge-base SHA, return the
 * revision string to use for the gutter's blob fetch — or `null` when the
 * merge-base SHA hasn't been resolved yet (the caller should wait).
 *
 * - `"head"`        → `"HEAD"` (always available).
 * - `"merge_base"`  → the cached SHA, or `null` if not yet resolved.
 */
export function selectGutterRevision(
  setting: "head" | "merge_base",
  cachedMergeBase: string | null,
): string | null {
  if (setting === "head") return "HEAD";
  return cachedMergeBase;
}

/**
 * Wires the git gutter into a mounted Monaco editor. Fetches the file's
 * blob at the configured revision once per `(workspaceId, filename, revision)`,
 * then recomputes line decorations on each buffer change (debounced 250 ms).
 *
 * The revision is selected by `editorGitGutterBase`:
 *   - "head"        → "HEAD"
 *   - "merge_base"  → diffMergeBase (lazily fetched via
 *                     compute_workspace_merge_base when not yet cached).
 *
 * Failure modes are silent (no toasts): missing merge-base, binary blob,
 * oversized file, IPC error — all leave the gutter cleared.
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
  // When the workspace path is a symlink, the editor buffer is the
  // resolved target while git's blob is the literal target string —
  // diffing those paints every line as modified, which is noise rather
  // than signal. Skip the gutter entirely in that case. We deliberately
  // don't try to compare the symlink target's blob: the target may be
  // outside the worktree (or untracked), so the cheapest correct
  // behavior is "no gutter for symlinks".
  isSymlink: boolean,
) {
  // `null` = gutter unavailable (no head, fetch error, binary, or revision
  // not yet resolved). Empty string `""` = file untracked at the revision;
  // treat every line as added.
  const [head, setHead] = useState<string | null>(null);
  const fetchVersionRef = useRef(0);

  const editorGitGutterBase = useAppStore((s) => s.editorGitGutterBase);
  const diffMergeBase = useAppStore((s) => s.diffMergeBase);
  const setDiffMergeBase = useAppStore((s) => s.setDiffMergeBase);

  const revision = selectGutterRevision(editorGitGutterBase, diffMergeBase);

  // One-shot merge-base resolution. Only fires when "merge_base" is
  // selected and the SHA isn't cached. Errors silently disable the
  // gutter — same UX as today's binary/oversized/no-head paths.
  useEffect(() => {
    // Resolve the merge-base on demand: fires only when "merge_base" is
    // selected and no SHA is cached (revision === null in that case).
    if (revision !== null || editorGitGutterBase !== "merge_base") return;
    let cancelled = false;
    computeWorkspaceMergeBase(workspaceId)
      .then((sha) => {
        if (!cancelled) setDiffMergeBase(sha);
      })
      .catch(() => {
        // Stay silent — gutter remains cleared.
      });
    return () => {
      cancelled = true;
    };
  }, [editorGitGutterBase, revision, workspaceId, setDiffMergeBase]);

  // Fetch the blob at `revision` whenever the file or revision changes. The
  // version counter discards stale responses if a newer fetch has already
  // started.
  useEffect(() => {
    const version = ++fetchVersionRef.current;

    // Bail for symlinks — see the doc comment on `isSymlink` above.
    if (isSymlink) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHead(null);
      collectionRef.current?.clear();
      return;
    }

    // Bail when the file is past the cap — gutter is disabled regardless.
    // We snapshot `buffer.length` at run time so we don't fire per
    // keystroke (`buffer` is intentionally not in the deps array).
    if (buffer.length > GUTTER_MAX_BYTES) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHead(null);
      collectionRef.current?.clear();
      return;
    }

    // Bail when the revision isn't resolved yet (merge-base in flight).
    if (revision === null) {
      setHead(null);
      collectionRef.current?.clear();
      return;
    }

    setHead(null);
    collectionRef.current?.clear();

    readWorkspaceFileAtRevision(workspaceId, filename, revision)
      .then((res) => {
        if (version !== fetchVersionRef.current) return;
        if (!res.exists_at_revision) {
          setHead("");
          return;
        }
        setHead(res.content);
      })
      .catch(() => {
        if (version !== fetchVersionRef.current) return;
        setHead(null);
      });
    // We intentionally do NOT depend on `buffer` — that would refire the
    // fetch on every keystroke. We snapshot `buffer.length` at run time.
    //
    // `diffMergeBase` is included even though `revision` already encodes
    // it for `merge_base` mode: in `head` mode `revision` is the constant
    // string `"HEAD"`, so without this dep the fetch effect would no
    // longer pick up the invalidation signal RightSidebar's
    // `setDiffFiles(...)` produces after a refresh (e.g. once a commit
    // has moved HEAD). Re-fetching on `diffMergeBase` change is the
    // cheapest way to inherit that signal in both modes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, filename, revision, diffMergeBase, collectionRef, isSymlink]);

  // Debounced recompute on every buffer or head change. (Unchanged from
  // before Task 6 except that it now responds to `head` updates produced
  // by the dynamic-revision fetch above.)
  useEffect(() => {
    const collection = collectionRef.current;
    const monacoInstance = monacoRef.current;
    if (head === null || !collection || !monacoInstance) return;

    const timer = window.setTimeout(() => {
      if (buffer.length > GUTTER_MAX_BYTES || exceedsLineCap(buffer)) {
        collection.clear();
        return;
      }
      const changes = computeLineChanges(head, buffer);
      const decos = lineChangesToDecorations(changes, monacoInstance);
      collection.set(decos);
    }, GUTTER_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [head, buffer, monacoRef, collectionRef]);
}

/**
 * Cheap line-count check that bails out as soon as the cap is exceeded.
 * Counts '\n' (charCode 10) without allocating; saves per-keystroke array
 * allocation that `buffer.split("\n").length` would do.
 */
function exceedsLineCap(buffer: string): boolean {
  let nlCount = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer.charCodeAt(i) === 10) {
      nlCount++;
      // The cap counts lines, not newlines. A buffer with N newlines has
      // either N or N+1 lines (depending on trailing newline). Bail when
      // we've definitely exceeded the cap.
      if (nlCount >= GUTTER_MAX_LINES) return true;
    }
  }
  return false;
}
