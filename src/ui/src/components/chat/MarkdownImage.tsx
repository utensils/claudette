import { createContext, memo, useContext, useEffect, useState } from "react";
import { readWorkspaceFileBytes } from "../../services/tauri";
import { imageMediaType } from "../../utils/fileIcons";
import { base64ToBytes } from "../../utils/base64";

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
const SVG_MARKDOWN_IMAGE_CLASS = "cc-markdown-image-svg";

function stripUrlSuffix(href: string): string {
  const query = href.indexOf("?");
  const hash = href.indexOf("#");
  const end = [query, hash].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  return end === undefined ? href : href.slice(0, end);
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function joinRelative(dir: string, href: string): string {
  const pathHref = decodePath(stripUrlSuffix(href));
  // Leading `/` — treat as workspace-root relative. Common in READMEs that
  // reference assets via paths like `/assets/logo.png` regardless of which
  // file is rendering them. Drop the slash and skip the dir prefix.
  if (pathHref.startsWith("/")) return pathHref.replace(/^\/+/, "");
  // Otherwise treat as relative to the markdown file's own directory. We
  // don't try to traverse `..` — repo READMEs almost never reference parent
  // directories, and the backend enforces workspace-relative paths anyway.
  // If `..` is seen, leave it for the backend to reject so the failure
  // surfaces visibly.
  const cleaned = pathHref.replace(/^\.\//, "");
  if (!dir) return cleaned;
  return `${dir}/${cleaned}`;
}

function isSvgMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase() === "image/svg+xml";
}

function svgDataUrlFromBase64(bytesB64: string): string | null {
  try {
    const svg = new TextDecoder().decode(base64ToBytes(bytesB64));
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    return null;
  }
}

function imageDataUrl(mediaType: string, bytesB64: string): string {
  if (isSvgMediaType(mediaType)) {
    return svgDataUrlFromBase64(bytesB64) ?? `data:${mediaType};base64,${bytesB64}`;
  }
  return `data:${mediaType};base64,${bytesB64}`;
}

function dataUrlIsSvg(src: string): boolean {
  return /^data:image\/svg\+xml(?:[;,]|$)/i.test(src);
}

function firstSrcSetUrl(srcSet: string): string {
  return srcSet.trim().split(/\s+/)[0] ?? "";
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
        setResolved(imageDataUrl(mime, res.bytes_b64));
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
  const hasExplicitSize =
    rest.width != null ||
    rest.height != null ||
    rest.style?.width != null ||
    rest.style?.height != null;
  const className = [
    rest.className,
    dataUrlIsSvg(resolved) && !hasExplicitSize ? SVG_MARKDOWN_IMAGE_CLASS : null,
  ]
    .filter(Boolean)
    .join(" ") || undefined;
  return <img {...rest} src={resolved} alt={alt} className={className} />;
});

/**
 * Raw HTML GitHub README themes use:
 *
 *   <picture>
 *     <source media="(prefers-color-scheme: dark)" srcset="...svg">
 *     <img src="...svg">
 *   </picture>
 *
 * The `<img>` override above resolves the fallback source, but WebKit will
 * prefer the matching `<source srcset>` when present. Resolve that too so
 * dark/light GitHub-style README art works inside the Tauri webview.
 */
export const MarkdownPictureSource = memo(function MarkdownPictureSource(
  props: React.SourceHTMLAttributes<HTMLSourceElement> & { node?: unknown },
) {
  const { node: _node, srcSet, ...rest } = props;
  const base = useMarkdownImageBase();
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    if (!srcSet) {
      setResolved(null);
      return;
    }
    const src = firstSrcSetUrl(srcSet);
    if (
      !src ||
      ABSOLUTE_HREF.test(src) ||
      src.startsWith("data:") ||
      src.startsWith("blob:")
    ) {
      setResolved(srcSet);
      return;
    }
    if (!base) {
      setResolved(srcSet);
      return;
    }

    const path = joinRelative(base.dir, src);
    let cancelled = false;
    readWorkspaceFileBytes(base.workspaceId, path)
      .then((res) => {
        if (cancelled) return;
        const mime = imageMediaType(path) ?? "image/png";
        const dataUrl = imageDataUrl(mime, res.bytes_b64);
        const descriptor = srcSet.trim().slice(src.length).trim();
        setResolved(descriptor ? `${dataUrl} ${descriptor}` : dataUrl);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Failed to load markdown picture source:", path, err);
        setResolved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [srcSet, base]);

  if (resolved == null) return null;
  return <source {...rest} srcSet={resolved} />;
});
