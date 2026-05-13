import { memo, useMemo } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import {
  preprocessContent,
  MARKDOWN_COMPONENTS,
  MarkdownFileOpenContext,
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
  safeUrlTransform,
} from "../../utils/markdown";
import { MarkdownImage, MarkdownPictureSource } from "./MarkdownImage";
import styles from "./MessageMarkdown.module.css";

// Single shared component map. `MARKDOWN_COMPONENTS` covers `<a>`, `<pre>`,
// `<code>`, etc.; we layer `<img>` on top so relative-href images can be
// resolved against a workspace base path when a `<MarkdownImageBaseProvider>`
// wraps the renderer (FileViewer markdown preview), and pass through
// otherwise (chat).
const COMPONENTS: Components = {
  ...MARKDOWN_COMPONENTS,
  img: MarkdownImage,
  source: MarkdownPictureSource,
};

/**
 * Memoized markdown renderer. Same `content` ⇒ same React element, so both the
 * `preprocessContent` ANSI/callout pass and the `react-markdown` parse are
 * skipped on parent re-renders that don't change the text. For completed
 * messages this means render-once-and-done; for the live streaming subtree it
 * shields against unrelated store updates.
 *
 * The output is wrapped in a co-located `.body` class so per-element typography
 * (h1–h6, tables, code blocks, lists, etc.) travels with the component. Every
 * surface that renders `<MessageMarkdown>` — chat, Files-tab markdown preview,
 * markdown attachment cards — gets identical rendering without each consumer
 * having to re-declare the rules.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  onOpenFile,
  resolveFilePath,
}: {
  content: string;
  onOpenFile?: (path: string) => boolean;
  resolveFilePath?: (path: string) => string | null;
}) {
  const preprocessed = useMemo(() => preprocessContent(content), [content]);
  const body = (
    <div className={styles.body}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
        urlTransform={safeUrlTransform}
      >
        {preprocessed}
      </Markdown>
    </div>
  );
  if (!onOpenFile && !resolveFilePath) return body;
  return (
    <MarkdownFileOpenContext.Provider
      value={{
        openFile: onOpenFile ?? (() => false),
        resolveFilePath,
      }}
    >
      {body}
    </MarkdownFileOpenContext.Provider>
  );
});
