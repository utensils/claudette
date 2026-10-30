import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import { loadAttachmentData } from "../../services/tauri";
import type { ChatAttachment, ChatMessage } from "../../types/chat";
import {
  type DownloadableAttachment,
  openAttachmentWithDefaultApp,
} from "../../utils/attachmentDownload";
import { detectFileReferences } from "../../utils/filePathLinks";
import { ChatAuthFailureCallout } from "../auth/ChatAuthFailureCallout";
import { cleanClaudeAuthError, isClaudeAuthError } from "../auth/claudeAuth";
import styles from "./ChatPanel.module.css";
import { HighlightedMessageMarkdown } from "./HighlightedMessageMarkdown";
import { HighlightedPlainText } from "./HighlightedPlainText";
import { MessageAttachment, isTextDataMediaType } from "./MessageAttachment";
import { MessageCopyButton } from "./MessageCopyButton";
import { roleClassKey, shouldRenderAsMarkdown } from "./messageRendering";
import { PdfThumbnail } from "./PdfThumbnail";
import { ThinkingBlock } from "./ThinkingBlock";
import { renderUltrathinkText } from "./ultrathink";

type AttachmentContextMenuHandler = (
  e: React.MouseEvent,
  attachment: DownloadableAttachment,
  attachmentId?: string,
) => void;

type AttachmentClickHandler = (
  e: React.MouseEvent,
  attachment: DownloadableAttachment,
) => void;

/**
 * One User / Assistant / non-sentinel System message.
 *
 * Memoized and fed only per-message data plus stable callbacks, so streaming
 * a new message or toggling a completed turn doesn't re-render (and
 * re-scan) every earlier message. The per-message work that used to run on
 * every transcript render — the auth-error check, which lower-cases the
 * whole message, and the file-reference regex scan for user messages — now
 * runs only when this message's inputs change.
 */
export const ChatMessageBubble = memo(function ChatMessageBubble({
  msg,
  attachments,
  showThinkingBlocks,
  toolDisplayMode,
  searchQuery,
  isLatestAuthFailure,
  isResolvedAuthFailure,
  resolveFilePath,
  openFile,
  onAttachmentClick,
  onAttachmentContextMenu,
}: {
  msg: ChatMessage;
  attachments?: readonly ChatAttachment[];
  showThinkingBlocks: boolean;
  toolDisplayMode: ToolDisplayMode;
  searchQuery: string;
  /** This is the newest auth-failure message in the window (gets the
   *  interactive sign-in callout). */
  isLatestAuthFailure: boolean;
  /** The user already re-authenticated from this message's callout. */
  isResolvedAuthFailure: boolean;
  resolveFilePath: (path: string) => string | null;
  openFile: (path: string) => boolean;
  onAttachmentClick?: AttachmentClickHandler;
  onAttachmentContextMenu?: AttachmentContextMenuHandler;
}) {
  const { t } = useTranslation("chat");
  const isAuthFailureMessage = useMemo(
    () =>
      (msg.role === "Assistant" || msg.role === "System") &&
      isClaudeAuthError(msg.content),
    [msg.role, msg.content],
  );
  const plainTextNodes = useMemo(
    () =>
      shouldRenderAsMarkdown(msg.role)
        ? null
        : renderFileLinkedPlainText(msg.content, {
            animated: false,
            styles: {
              ultrathinkChar: styles.ultrathinkChar,
              ultrathinkCharAnimated: styles.ultrathinkCharAnimated,
            },
            resolveFilePath,
            openFile,
          }),
    [msg.role, msg.content, resolveFilePath, openFile],
  );

  return (
    <div
      className={`${styles.message} ${styles[
        roleClassKey(msg.role, msg.content, {
          forceSystemBlock: isAuthFailureMessage,
        })
      ]}${
        msg.role === "Assistant" && msg.thinking && showThinkingBlocks
          ? ` ${styles.messageLeadingThinking}`
          : ""
      }`}
    >
      {msg.role === "User" && (
        <div className={styles.roleLabel}>{t("you_label")}</div>
      )}
      {msg.role === "User" && msg.content.length > 0 && (
        <MessageCopyButton
          text={msg.content}
          className={styles.userMessageCopyButton}
        />
      )}
      {msg.role === "Assistant" && msg.thinking && showThinkingBlocks && (
        <ThinkingBlock
          content={msg.thinking}
          isStreaming={false}
          inline={toolDisplayMode === "inline"}
          searchQuery={searchQuery}
        />
      )}
      <div className={styles.content}>
        {attachments && attachments.length > 0 && (
          <MessageAttachmentGallery
            attachments={attachments}
            onAttachmentClick={onAttachmentClick}
            onAttachmentContextMenu={onAttachmentContextMenu}
          />
        )}
        {isAuthFailureMessage && isLatestAuthFailure && !isResolvedAuthFailure ? (
          <ChatAuthFailureCallout error={msg.content} messageId={msg.id} />
        ) : isAuthFailureMessage ? (
          <div
            className={
              isResolvedAuthFailure
                ? styles.authFailureResolvedText
                : styles.authFailureText
            }
          >
            {isResolvedAuthFailure ? (
              <>
                <span className={styles.authResolvedLabel}>
                  {t("auth_resolved_label")}
                </span>
                {t("auth_resolved_message")}
              </>
            ) : (
              cleanClaudeAuthError(msg.content)
            )}
          </div>
        ) : shouldRenderAsMarkdown(msg.role) ? (
          // Assistant + System: run through Markdown so plan-mode dumps,
          // setup-script output, and other multi-line system notes preserve
          // headings, lists, and code blocks instead of collapsing newlines
          // into a single paragraph.
          <HighlightedMessageMarkdown
            content={msg.content}
            query={searchQuery}
            onOpenFile={openFile}
            resolveFilePath={resolveFilePath}
          />
        ) : searchQuery ? (
          // While the search bar is open, render user messages as plain
          // highlighted text so matches inside them get marked. The
          // ultrathink rainbow animation is suppressed in this mode —
          // searchability wins over the easter egg.
          <HighlightedPlainText text={msg.content} query={searchQuery} />
        ) : (
          plainTextNodes
        )}
      </div>
    </div>
  );
});

/** Images, PDFs, and text-data attachments shown inside a message bubble. */
function MessageAttachmentGallery({
  attachments,
  onAttachmentClick,
  onAttachmentContextMenu,
}: {
  attachments: readonly ChatAttachment[];
  onAttachmentClick?: AttachmentClickHandler;
  onAttachmentContextMenu?: AttachmentContextMenuHandler;
}) {
  return (
    <div className={styles.messageImages}>
      {attachments.map((att) => {
        const downloadable: DownloadableAttachment = {
          filename: att.filename,
          media_type: att.media_type,
          data_base64: att.data_base64,
        };
        if (att.media_type === "application/pdf") {
          return (
            <PdfThumbnail
              key={att.id}
              dataBase64={att.data_base64 || undefined}
              attachmentId={att.id}
              filename={att.filename}
              className={styles.messageImage}
              onClick={() => {
                (async () => {
                  // Persisted attachments strip data_base64 on first load to
                  // avoid IPC bloat — fetch on demand.
                  let b64 = att.data_base64;
                  if (!b64) {
                    b64 = await loadAttachmentData(att.id);
                  }
                  await openAttachmentWithDefaultApp({
                    filename: att.filename,
                    media_type: att.media_type,
                    data_base64: b64,
                  });
                })().catch((err) => console.error("Failed to open PDF:", err));
              }}
              onContextMenu={(e) => onAttachmentContextMenu?.(e, downloadable, att.id)}
            />
          );
        }
        if (isTextDataMediaType(att.media_type)) {
          return (
            <MessageAttachment
              key={att.id}
              attachment={att}
              handlers={{ onContextMenu: onAttachmentContextMenu }}
            />
          );
        }
        return (
          <img
            key={att.id}
            src={`data:${att.media_type};base64,${att.data_base64}`}
            alt={att.filename}
            className={styles.messageImage}
            onClick={(e) => onAttachmentClick?.(e, downloadable)}
            onContextMenu={(e) => onAttachmentContextMenu?.(e, downloadable, att.id)}
          />
        );
      })}
    </div>
  );
}

function renderFileLinkedPlainText(
  text: string,
  options: {
    animated: boolean;
    styles: Parameters<typeof renderUltrathinkText>[1]["styles"];
    resolveFilePath: (path: string) => string | null;
    openFile: (path: string) => boolean;
  },
): React.ReactNode {
  const matches = detectFileReferences(text).flatMap((match) => {
    const resolvedPath = options.resolveFilePath(match.path);
    return resolvedPath ? [{ ...match, resolvedPath }] : [];
  });
  if (matches.length === 0) {
    return renderUltrathinkText(text, options);
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      nodes.push(
        <React.Fragment key={`text-${cursor}`}>
          {renderUltrathinkText(text.slice(cursor, match.start), options)}
        </React.Fragment>,
      );
    }
    const label = match.text ?? match.path;
    nodes.push(
      <button
        type="button"
        className="cc-file-path-link"
        title={match.resolvedPath}
        key={`file-${match.start}-${match.end}`}
        onClick={() => options.openFile(match.resolvedPath)}
      >
        {label}
      </button>,
    );
    cursor = match.end;
  }
  if (cursor < text.length) {
    nodes.push(
      <React.Fragment key={`text-${cursor}`}>
        {renderUltrathinkText(text.slice(cursor), options)}
      </React.Fragment>,
    );
  }
  return nodes;
}
