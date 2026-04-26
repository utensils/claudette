import { Fragment, memo, useMemo } from "react";
import { findAllRanges, splitByRanges } from "../../utils/textSearch";

/**
 * Renders plain text with `<mark class="cc-search-match">` segments around
 * every case-insensitive substring match of `query`. When `query` is empty,
 * the text renders as-is — no DOM nodes are inserted, so the search-off
 * path has zero overhead.
 *
 * The shared `cc-search-match` class is what `ChatSearchBar` queries to
 * count and target the active match. Don't rename without updating the bar.
 */
export const HighlightedPlainText = memo(function HighlightedPlainText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const segments = useMemo(() => {
    if (!query) return null;
    const ranges = findAllRanges(text, query);
    if (ranges.length === 0) return null;
    return splitByRanges(text, ranges);
  }, [text, query]);

  if (!segments) {
    return <>{text}</>;
  }
  return (
    <>
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {seg.kind === "match" ? (
            <mark className="cc-search-match">{seg.text}</mark>
          ) : (
            seg.text
          )}
        </Fragment>
      ))}
    </>
  );
});
