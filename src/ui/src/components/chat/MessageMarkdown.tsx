import { memo, useMemo } from "react";
import Markdown from "react-markdown";
import {
  preprocessContent,
  MARKDOWN_COMPONENTS,
  REHYPE_PLUGINS,
  REMARK_PLUGINS,
  safeUrlTransform,
} from "../../utils/markdown";
import styles from "./MessageMarkdown.module.css";

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
}: {
  content: string;
}) {
  const preprocessed = useMemo(() => preprocessContent(content), [content]);
  return (
    <div className={styles.body}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
        urlTransform={safeUrlTransform}
      >
        {preprocessed}
      </Markdown>
    </div>
  );
});
