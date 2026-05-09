import { useEffect, useMemo, useReducer, type MouseEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolActivity } from "../../stores/useAppStore";
import { useAppStore } from "../../stores/useAppStore";
import { extractToolSummary, relativizePath } from "../../hooks/toolSummary";
import { getCachedHighlight, highlightCode } from "../../utils/highlight";
import { HighlightedPlainText } from "./HighlightedPlainText";
import styles from "./ChatPanel.module.css";
import { toolColor } from "./chatHelpers";
import { CodeBlock } from "./CodeBlock";
import { InlineEditSummary } from "./EditChangeSummary";
import { summarizeToolActivityEdit } from "./editActivitySummary";
import { resolveToolSummary } from "./toolMetadata";

interface ToolActivityRowProps {
  activity: ToolActivity;
  searchQuery: string;
  worktreePath?: string | null;
}

interface ToolDetails {
  content: string;
  lang: string | null;
}

export function ToolActivityRow({
  activity,
  searchQuery,
  worktreePath,
}: ToolActivityRowProps) {
  const expanded = useAppStore((s) => !!s.expandedToolUseIds[activity.toolUseId]);
  const toggleToolUseExpanded = useAppStore((s) => s.toggleToolUseExpanded);
  const editSummary = summarizeToolActivityEdit(activity);
  const summary = activitySummaryText(activity);
  const details = useMemo(() => toolDetails(activity), [activity]);
  const cachedHtml = details.lang
    ? getCachedHighlight(details.content, details.lang)
    : null;
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!expanded || !details.lang || cachedHtml != null) return;
    let cancelled = false;
    void highlightCode(details.content, details.lang).then((html) => {
      if (!cancelled && html != null) forceUpdate();
    });
    return () => {
      cancelled = true;
    };
  }, [cachedHtml, details.content, details.lang, expanded]);

  const label = `${expanded ? "Collapse" : "Expand"} ${activity.toolName} input details`;

  return (
    <div key={activity.toolUseId} className={styles.toolActivity}>
      <div className={styles.toolHeader}>
        <button
          type="button"
          role="button"
          className={`${styles.toolDetailsToggle} ${
            expanded ? styles.toolDetailsToggleExpanded : ""
          }`}
          aria-expanded={expanded}
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation();
            toggleToolUseExpanded(activity.toolUseId);
          }}
        >
          <ChevronRight size={13} aria-hidden="true" />
        </button>
        {editSummary ? (
          <InlineEditSummary
            summary={editSummary}
            searchQuery={searchQuery}
            worktreePath={worktreePath}
          />
        ) : (
          <span
            className={styles.toolName}
            style={{ color: toolColor(activity.toolName) }}
          >
            {activity.toolName}
          </span>
        )}
        {!editSummary && summary && (
          <span className={styles.toolSummary}>
            <HighlightedPlainText
              text={relativizePath(summary, worktreePath)}
              query={searchQuery}
            />
          </span>
        )}
      </div>
      {expanded && (
        <CodeBlock
          className={styles.toolDetailsCode}
          onClick={(event: MouseEvent<HTMLPreElement>) => event.stopPropagation()}
        >
          {details.lang && cachedHtml != null ? (
            <code
              className={`language-${details.lang}`}
              dangerouslySetInnerHTML={{ __html: cachedHtml }}
            />
          ) : (
            <code className={details.lang ? `language-${details.lang}` : undefined}>
              {details.content}
            </code>
          )}
        </CodeBlock>
      )}
    </div>
  );
}

function activitySummaryText(activity: ToolActivity): string {
  return (
    activity.summary ||
    activity.agentDescription ||
    extractToolSummary(activity.toolName, activity.inputJson) ||
    ""
  );
}

function toolDetails(activity: ToolActivity): ToolDetails {
  const input = parseObject(activity.inputJson);
  const display = resolveToolSummary(activity.toolName, activity.inputJson);

  if (input && shouldShowStructuredInput(input, display.lang)) {
    return { content: JSON.stringify(input, null, 2), lang: "json" };
  }

  if (display.fullContent) {
    return { content: display.fullContent, lang: display.lang };
  }

  if (input) {
    return { content: JSON.stringify(input, null, 2), lang: "json" };
  }

  return { content: activity.inputJson || "{}", lang: null };
}

function parseObject(inputJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(inputJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function shouldShowStructuredInput(
  input: Record<string, unknown>,
  summaryLang: string | null,
): boolean {
  if (summaryLang) return false;
  return Object.keys(input).length > 1;
}
