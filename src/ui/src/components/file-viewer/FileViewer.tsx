import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, Code, Copy, Eye, Pencil, Save } from "lucide-react";
import { writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import {
  selectActiveFileTabPath,
  useAppStore,
} from "../../stores/useAppStore";
import { fileBufferKey } from "../../stores/slices/fileTreeSlice";
import {
  readWorkspaceFileBytes,
  readWorkspaceFileForViewer,
  writeWorkspaceFile,
} from "../../services/tauri";
import { WorkspacePanelHeader } from "../shared/WorkspacePanelHeader";
import { PaneToolbar } from "../shared/PaneToolbar";
import { SegmentedControl } from "../shared/SegmentedControl";
import { IconButton } from "../shared/IconButton";
import { SessionTabs } from "../chat/SessionTabs";
import { MessageMarkdown } from "../chat/MessageMarkdown";
import { imageMediaType, isImagePath } from "../../utils/fileIcons";
import styles from "./FileViewer.module.css";

const MonacoEditor = lazy(() =>
  import("./MonacoEditor").then((m) => ({ default: m.MonacoEditor })),
);

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
/** Hard cap above which Edit mode is disabled. Aligns with the backend's
 *  viewer-text cap so the user gets the disabled-button affordance before
 *  hitting a backend truncation. */
const EDIT_SIZE_LIMIT_BYTES = 5 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FileViewer = memo(function FileViewer() {
  const { t } = useTranslation("chat");
  const workspaceId = useAppStore((s) => s.selectedWorkspaceId);
  const path = useAppStore(selectActiveFileTabPath);

  if (!workspaceId || !path) return null;

  return <FileViewerInner workspaceId={workspaceId} path={path} t={t} />;
});

interface FileViewerInnerProps {
  workspaceId: string;
  path: string;
  t: ReturnType<typeof useTranslation<"chat">>["t"];
}

function FileViewerInner({ workspaceId, path, t }: FileViewerInnerProps) {
  const bufferKey = fileBufferKey(workspaceId, path);
  const bufferState = useAppStore((s) => s.fileBuffers[bufferKey]);
  const setFileBufferLoaded = useAppStore((s) => s.setFileBufferLoaded);
  const setFileBufferLoadError = useAppStore((s) => s.setFileBufferLoadError);
  const setFileBufferContent = useAppStore((s) => s.setFileBufferContent);
  const setFileBufferSaved = useAppStore((s) => s.setFileBufferSaved);
  const setFileTabMode = useAppStore((s) => s.setFileTabMode);
  const setFileTabPreview = useAppStore((s) => s.setFileTabPreview);
  const addToast = useAppStore((s) => s.addToast);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [saving, setSaving] = useState(false);
  const copyResetRef = useRef<number | null>(null);

  // Reset copy UI state when the active tab changes.
  useEffect(() => {
    setCopyState("idle");
    if (copyResetRef.current !== null) {
      window.clearTimeout(copyResetRef.current);
      copyResetRef.current = null;
    }
  }, [path]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    };
  }, []);

  const isMarkdown = MARKDOWN_EXT.test(path);
  const isImage = isImagePath(path);

  // Initial load. Triggered when the buffer entry exists but isn't loaded
  // yet (`loaded=false`). The slice seeds an unloaded entry on `openFileTab`,
  // so this fires exactly once per opened tab. Subsequent tab switches
  // back to this path skip the fetch — the buffer's already in the store.
  const loadVersionRef = useRef(0);
  useEffect(() => {
    if (!bufferState || bufferState.loaded) return;
    const version = ++loadVersionRef.current;

    if (isImage) {
      readWorkspaceFileBytes(workspaceId, path)
        .then((res) => {
          if (version !== loadVersionRef.current) return;
          setFileBufferLoaded(workspaceId, path, {
            baseline: "",
            isBinary: false,
            sizeBytes: res.size_bytes,
            truncated: res.truncated,
            imageBytesB64: res.bytes_b64,
          });
        })
        .catch((e) => {
          if (version !== loadVersionRef.current) return;
          setFileBufferLoadError(workspaceId, path, String(e));
        });
    } else {
      readWorkspaceFileForViewer(workspaceId, path)
        .then((res) => {
          if (version !== loadVersionRef.current) return;
          const baseline = res.content ?? "";
          setFileBufferLoaded(workspaceId, path, {
            baseline,
            isBinary: res.is_binary,
            sizeBytes: res.size_bytes,
            truncated: res.truncated,
            imageBytesB64: null,
          });
        })
        .catch((e) => {
          if (version !== loadVersionRef.current) return;
          setFileBufferLoadError(workspaceId, path, String(e));
        });
    }
  }, [
    bufferState,
    isImage,
    workspaceId,
    path,
    setFileBufferLoaded,
    setFileBufferLoadError,
  ]);

  const dirty = !!bufferState && bufferState.buffer !== bufferState.baseline;

  const editDisabledReason = useMemo<string | null>(() => {
    if (!bufferState || !bufferState.loaded) return null;
    if (isImage) return t("file_edit_disabled_image");
    if (bufferState.isBinary) return t("file_edit_disabled_binary");
    if (bufferState.sizeBytes > EDIT_SIZE_LIMIT_BYTES) {
      return t("file_edit_disabled_too_large", {
        size: formatBytes(bufferState.sizeBytes),
      });
    }
    if (bufferState.truncated) return t("file_edit_disabled_truncated");
    return null;
  }, [bufferState, isImage, t]);
  const editDisabled = editDisabledReason !== null;

  // If the user toggled Edit on and then opened (or switched to) a file
  // that can't be edited, force the mode back to View.
  useEffect(() => {
    if (editDisabled && bufferState?.mode === "edit") {
      setFileTabMode(workspaceId, path, "view");
    }
  }, [editDisabled, bufferState?.mode, workspaceId, path, setFileTabMode]);

  const handleBufferChange = useCallback(
    (next: string) => {
      setFileBufferContent(workspaceId, path, next);
    },
    [workspaceId, path, setFileBufferContent],
  );

  const handleCopy = useCallback(async () => {
    if (!bufferState) return;
    const requestedPath = path;
    let nextState: "copied" | "error";
    try {
      if (isImage || bufferState.isBinary) {
        nextState = "error";
      } else {
        await clipboardWriteText(bufferState.buffer);
        nextState = "copied";
      }
    } catch (e) {
      console.error("Copy file contents failed:", e);
      nextState = "error";
    }
    // Bail if the user switched tabs mid-async.
    if (selectActiveFileTabPath(useAppStore.getState()) !== requestedPath) return;
    setCopyState(nextState);
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => setCopyState("idle"), 1500);
  }, [bufferState, isImage, path]);

  const handleSave = useCallback(async () => {
    if (!bufferState || !dirty || saving) return;
    const requestedPath = path;
    const snapshot = bufferState.buffer;
    setSaving(true);
    try {
      await writeWorkspaceFile(workspaceId, requestedPath, snapshot);
      // The user may have switched tabs mid-save. Always update the
      // baseline of the path we actually wrote — the saved file is canonical
      // regardless of which tab is now active. Just don't show the toast on
      // a different tab to avoid confusing the user about which file saved.
      setFileBufferSaved(workspaceId, requestedPath, snapshot);
      if (selectActiveFileTabPath(useAppStore.getState()) === requestedPath) {
        addToast(t("file_save_success"));
      }
    } catch (e) {
      console.error("Save failed:", e);
      addToast(t("file_save_failed", { error: String(e) }));
      // Buffer stays dirty so the user doesn't lose work.
    } finally {
      setSaving(false);
    }
  }, [bufferState, dirty, saving, workspaceId, path, setFileBufferSaved, addToast, t]);

  const showMarkdownToggle = isMarkdown && bufferState?.mode === "view";
  const showSourceEditor =
    !isImage &&
    !bufferState?.isBinary &&
    (bufferState?.mode === "edit" ||
      !showMarkdownToggle ||
      bufferState?.preview === "source");
  const showMarkdownPreview =
    showMarkdownToggle &&
    bufferState?.preview === "preview" &&
    bufferState?.loaded;

  return (
    <div className={styles.viewer}>
      <WorkspacePanelHeader />
      <SessionTabs workspaceId={workspaceId} />
      <PaneToolbar
        path={path}
        dirty={dirty}
        actions={
          <>
            <IconButton
              onClick={handleCopy}
              tooltip={
                copyState === "copied"
                  ? t("diff_tooltip_copied")
                  : copyState === "error"
                    ? t("diff_tooltip_copy_failed")
                    : t("diff_tooltip_copy_contents")
              }
              aria-live="polite"
              disabled={isImage || bufferState?.isBinary}
            >
              {copyState === "copied" ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
            </IconButton>
            {showMarkdownToggle && (
              <SegmentedControl
                ariaLabel={t("file_markdown_view_mode_aria")}
                value={bufferState!.preview}
                onChange={(p) => setFileTabPreview(workspaceId, path, p)}
                options={[
                  {
                    value: "source",
                    icon: <Code size={14} aria-hidden="true" />,
                    tooltip: t("file_tooltip_source"),
                  },
                  {
                    value: "preview",
                    icon: <BookOpen size={14} aria-hidden="true" />,
                    tooltip: t("file_tooltip_markdown_preview"),
                  },
                ]}
              />
            )}
            <SegmentedControl
              ariaLabel={t("file_view_mode_aria")}
              value={bufferState?.mode ?? "view"}
              onChange={(m) => setFileTabMode(workspaceId, path, m)}
              options={[
                {
                  value: "view",
                  icon: <Eye size={14} aria-hidden="true" />,
                  tooltip: t("file_tooltip_view"),
                },
                {
                  value: "edit",
                  icon: <Pencil size={14} aria-hidden="true" />,
                  tooltip: t("file_tooltip_edit"),
                  disabled: editDisabled,
                  disabledTooltip: editDisabledReason ?? undefined,
                },
              ]}
            />
            {bufferState?.mode === "edit" && (
              <IconButton
                onClick={handleSave}
                tooltip={
                  dirty ? t("file_tooltip_save") : t("file_tooltip_save_clean")
                }
                disabled={!dirty || saving}
              >
                <Save size={14} aria-hidden="true" />
              </IconButton>
            )}
          </>
        }
      />
      <div className={styles.content}>
        {!bufferState || !bufferState.loaded ? (
          <div className={styles.center}>{t("file_loading")}</div>
        ) : bufferState.loadError ? (
          <div className={styles.center}>
            {t("file_load_failed", { error: bufferState.loadError })}
          </div>
        ) : isImage && bufferState.imageBytesB64 ? (
          <ImageView
            bytesB64={bufferState.imageBytesB64}
            sizeBytes={bufferState.sizeBytes}
            filename={path}
          />
        ) : bufferState.isBinary ? (
          <div className={styles.center}>{t("file_preview_not_available")}</div>
        ) : showMarkdownPreview ? (
          <div className={styles.markdownBody}>
            <MessageMarkdown content={bufferState.buffer} />
          </div>
        ) : showSourceEditor ? (
          <Suspense fallback={<div className={styles.center}>{t("file_loading")}</div>}>
            <MonacoEditor
              key={path}
              initialValue={bufferState.buffer}
              filename={path}
              readOnly={bufferState.mode === "view"}
              onChange={handleBufferChange}
              onSave={handleSave}
            />
          </Suspense>
        ) : (
          <div className={styles.center}>{t("file_preview_not_available")}</div>
        )}
        {bufferState?.truncated && (
          <div className={styles.truncatedBanner}>
            {t("file_truncated_banner", {
              size: formatBytes(bufferState.sizeBytes),
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface ImageViewProps {
  bytesB64: string;
  sizeBytes: number;
  filename: string;
}

function ImageView({ bytesB64, sizeBytes, filename }: ImageViewProps) {
  const mediaType = imageMediaType(filename) ?? "image/png";
  const dataUrl = `data:${mediaType};base64,${bytesB64}`;
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(
    null,
  );
  return (
    <div className={styles.imageWrap}>
      <img
        src={dataUrl}
        alt={filename}
        className={styles.image}
        onLoad={(e) => {
          const img = e.currentTarget;
          setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
        }}
      />
      {dimensions && (
        <div className={styles.imageMeta}>
          {dimensions.w} × {dimensions.h} · {formatBytes(sizeBytes)}
        </div>
      )}
    </div>
  );
}
