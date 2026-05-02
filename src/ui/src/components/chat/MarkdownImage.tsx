import { createContext, memo, useContext, useEffect, useState } from "react";
import { readWorkspaceFileBytes } from "../../services/tauri";
import { imageMediaType } from "../../utils/fileIcons";

/**
 * Resolution context for relative `<img>` references inside `<MessageMarkdown>`.
 * Surfaces that render markdown out of a known workspace location (Files-tab
 * preview, future inline doc viewers) provide the workspaceId + the directory
 * of the file the markdown was loaded from. Without a provider, relative-href
 * images render as-is — chat assistant output goes that path because its
 * images are absolute (data: / https:) by the time they reach us.
 */
export interface MarkdownImageBase {
  workspaceId: string;
  /** Directory of the markdown source, relative to the workspace root.
   *  Empty string when the source lives at the workspace root. */
  dir: string;
}

const MarkdownImageBaseContext = createContext<MarkdownImageBase | null>(null);

export const MarkdownImageBaseProvider = MarkdownImageBaseContext.Provider;

export function useMarkdownImageBase(): MarkdownImageBase | null {
  return useContext(MarkdownImageBaseContext);
}

const ABSOLUTE_HREF = /^(?:[a-z]+:|\/\/)/i;

function joinRelative(dir: string, href: string): string {
  // Strip `./` prefix and normalize. We don't try to traverse `..` — repo
  // READMEs almost never reference parent directories, and the backend
  // enforces workspace-relative paths anyway. If `..` is seen, leave it for
  // the backend to reject so the failure surfaces visibly.
  const cleaned = href.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!dir) return cleaned;
  return `${dir}/${cleaned}`;
}

/**
 * `<img>` override used by `MessageMarkdown`. Pass-through for absolute hrefs
 * (https:, data:, blob:, asset:) and for chat-side rendering where there's no
 * base provider. When a base is provided and the href is workspace-relative,
 * fetch the bytes through the existing `read_workspace_file_bytes` command and
 * render as a data URL so the webview's CSP doesn't have to know about each
 * workspace's filesystem path.
 */
export const MarkdownImage = memo(function MarkdownImage(
  props: React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown },
) {
  const { node: _node, src, alt, ...rest } = props;
  const base = useMarkdownImageBase();
  const [resolved, setResolved] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setErrored(false);
    if (!src) {
      setResolved(null);
      return;
    }
    if (ABSOLUTE_HREF.test(src) || src.startsWith("data:") || src.startsWith("blob:")) {
      setResolved(src);
      return;
    }
    if (!base) {
      // No base context (e.g. chat) — fall through. This is the same behavior
      // as before this component existed: relative paths just won't resolve.
      setResolved(src);
      return;
    }
    const path = joinRelative(base.dir, src);
    let cancelled = false;
    readWorkspaceFileBytes(base.workspaceId, path)
      .then((res) => {
        if (cancelled) return;
        const mime = imageMediaType(path) ?? "image/png";
        setResolved(`data:${mime};base64,${res.bytes_b64}`);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Failed to load markdown image:", path, err);
        setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src, base]);

  if (errored) {
    // Render the alt text inline so the reader still sees what the image was
    // supposed to convey; mirrors how plain HTML browsers fall back.
    return alt ? <span>{alt}</span> : null;
  }
  if (resolved == null) return null;
  return <img {...rest} src={resolved} alt={alt} />;
});
