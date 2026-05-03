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
import { BookOpen, Check, Code, Copy, Save } from "lucide-react";
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
import { MarkdownImageBaseProvider } from "../chat/MarkdownImage";
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
  const setFileTabPreview = useAppStore((s) => s.setFileTabPreview);
  const addToast = useAppStore((s) => s.addToast);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const [saving, setSaving] = useState(false);
  const copyResetRef = useRef<number | null>(null);

  // Reset transient per-tab UI state when the active tab/workspace changes
  // so an in-flight save/copy on a previous tab can't leak its disabled state
  // or pending callbacks into the newly mounted view.
  useEffect(() => {
    setCopyState("idle");
    setSaving(false);
    if (copyResetRef.current !== null) {
      window.clearTimeout(copyResetRef.current);
      copyResetRef.current = null;
    }
  }, [workspaceId, path]);

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

  // Files we render in the editor but won't let the user mutate. The
  // truncated banner below the editor explains the truncated case; the
  // others are obvious from the rendered output (image, "preview not
  // available" for binary) or rare enough not to warrant chrome (oversize
  // files between the edit cap and the viewer cap render read-only with
  // no banner — Monaco's read-only cursor signals it).
  const editDisabled =
    !!bufferState &&
    bufferState.loaded &&
    (isImage ||
      bufferState.isBinary ||
      bufferState.sizeBytes > EDIT_SIZE_LIMIT_BYTES ||
      bufferState.truncated);

  const handleBufferChange = useCallback(
    (next: string) => {
      setFileBufferContent(workspaceId, path, next);
    },
    [workspaceId, path, setFileBufferContent],
  );

  const handleCopy = useCallback(async () => {
    if (!bufferState) return;
    const requestedWorkspaceId = workspaceId;
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
    // Bail if the user switched tabs (or workspaces) mid-async — otherwise a
    // late completion would flip copy state on a different file.
    const state = useAppStore.getState();
    if (
      state.selectedWorkspaceId !== requestedWorkspaceId ||
      selectActiveFileTabPath(state) !== requestedPath
    ) {
      return;
    }
    setCopyState(nextState);
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    copyResetRef.current = window.setTimeout(() => setCopyState("idle"), 1500);
  }, [bufferState, isImage, workspaceId, path]);

  const handleSave = useCallback(async () => {
    if (!bufferState || !dirty || saving) return;
    const requestedWorkspaceId = workspaceId;
    const requestedPath = path;
    const snapshot = bufferState.buffer;
    setSaving(true);
    try {
      await writeWorkspaceFile(requestedWorkspaceId, requestedPath, snapshot);
      // The user may have switched tabs mid-save. Always update the
      // baseline of the path we actually wrote — the saved file is canonical
      // regardless of which tab is now active. Just don't show the toast on
      // a different tab/workspace to avoid confusing the user about which
      // file saved.
      setFileBufferSaved(requestedWorkspaceId, requestedPath, snapshot);
      const state = useAppStore.getState();
      if (
        state.selectedWorkspaceId === requestedWorkspaceId &&
        selectActiveFileTabPath(state) === requestedPath
      ) {
        addToast(t("file_save_success"));
      }
    } catch (e) {
      console.error("Save failed:", e);
      // Mirror the success guard: only surface the failure toast in the
      // workspace+tab the user actually triggered the save from. The buffer
      // stays dirty regardless so the user doesn't lose work, and the
      // console.error above gives an unconditional record of the failure.
      const state = useAppStore.getState();
      if (
        state.selectedWorkspaceId === requestedWorkspaceId &&
        selectActiveFileTabPath(state) === requestedPath
      ) {
        addToast(t("file_save_failed", { error: String(e) }));
      }
    } finally {
      setSaving(false);
    }
  }, [bufferState, dirty, saving, workspaceId, path, setFileBufferSaved, addToast, t]);

  const showMarkdownToggle = isMarkdown && !editDisabled;
  const showMarkdownPreview =
    showMarkdownToggle &&
    bufferState?.preview === "preview" &&
    bufferState?.loaded;
  const showSourceEditor =
    !isImage && !bufferState?.isBinary && !showMarkdownPreview;
  const showSaveButton =
    dirty && !editDisabled && !isImage && !bufferState?.isBinary && !showMarkdownPreview;

  const previewMode = bufferState?.preview ?? "source";
  const togglePreview = useCallback(() => {
    setFileTabPreview(
      workspaceId,
      path,
      previewMode === "preview" ? "source" : "preview",
    );
  }, [workspaceId, path, previewMode, setFileTabPreview]);

  // Cmd/Ctrl+Shift+V — toggle source/preview for the active markdown file
  // tab, mirroring the VS Code shortcut. The handler bows out when:
  //   * an overlay owns focus (settings, command palette, fuzzy finder,
  //     modal),
  //   * focus is in a typing target outside Monaco — chat composer textarea,
  //     terminal xterm textarea, contenteditable. On those Ctrl+Shift+V is
  //     commonly the "paste without formatting" shortcut and we don't want
  //     to hijack it. Monaco is exempt because that's the source view this
  //     shortcut is meant to flip out of — its hidden <textarea> would
  //     otherwise swallow the keystroke.
  //   * the event is a key-repeat. Holding the keys would otherwise toggle
  //     repeatedly, which is useless and disorienting.
  useEffect(() => {
    if (!showMarkdownToggle) return;
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Match on `e.key` rather than `e.code` so Cmd/Ctrl+Shift+V fires on
      // whichever physical key the user's layout assigns to "V" — `e.code`
      // is "KeyV" only on QWERTY-style layouts.
      if (!mod || !e.shiftKey || e.key.toLowerCase() !== "v") return;
      if (e.repeat) return;
      const state = useAppStore.getState();
      if (
        state.settingsOpen ||
        state.activeModal ||
        state.commandPaletteOpen ||
        state.fuzzyFinderOpen
      ) {
        return;
      }
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      const editable =
        tag === "input" || tag === "textarea" || el?.isContentEditable;
      const inMonaco = !!el?.closest(".monaco-editor");
      if (editable && !inMonaco) return;
      e.preventDefault();
      togglePreview();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showMarkdownToggle, togglePreview]);

  const isMacPlatform =
    typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
  const previewShortcutHint = isMacPlatform ? "⌘⇧V" : "Ctrl+Shift+V";

  // Resolution context for relative `<img>` references inside the rendered
  // markdown. Workspace-relative paths in a README — e.g. `./assets/logo.png`
  // — get joined onto the directory of this file so `MarkdownImage` can
  // load them through the existing `read_workspace_file_bytes` command.
  const markdownImageBase = useMemo(() => {
    const slash = path.lastIndexOf("/");
    return { workspaceId, dir: slash === -1 ? "" : path.slice(0, slash) };
  }, [workspaceId, path]);

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
              disabled={isImage || !bufferState?.loaded || bufferState?.isBinary}
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
                    tooltip: `${t("file_tooltip_source")} (${previewShortcutHint})`,
                  },
                  {
                    value: "preview",
                    icon: <BookOpen size={14} aria-hidden="true" />,
                    tooltip: `${t("file_tooltip_markdown_preview")} (${previewShortcutHint})`,
                  },
                ]}
              />
            )}
            {showSaveButton && (
              <IconButton
                onClick={handleSave}
                tooltip={t("file_tooltip_save")}
                disabled={saving}
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
        ) : isImage && bufferState.truncated ? (
          // Partial image bytes won't decode cleanly — surface a clear message
          // instead of letting the browser render a broken-image placeholder.
          <div className={styles.center}>
            {t("file_image_truncated", { size: formatBytes(bufferState.sizeBytes) })}
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
            <MarkdownImageBaseProvider value={markdownImageBase}>
              <MessageMarkdown content={bufferState.buffer} />
            </MarkdownImageBaseProvider>
          </div>
        ) : showSourceEditor ? (
          <Suspense fallback={<div className={styles.center}>{t("file_loading")}</div>}>
            <MonacoEditor
              key={path}
              workspaceId={workspaceId}
              initialValue={bufferState.buffer}
              filename={path}
              readOnly={editDisabled}
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
