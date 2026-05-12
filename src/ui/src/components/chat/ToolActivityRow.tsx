import { useEffect, useMemo, useReducer, type MouseEvent } from "react";
import { ChevronRight, WandSparkles } from "lucide-react";
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
import { isSkillActivity, skillActivationName } from "./toolActivityGroups";

interface ToolActivityRowProps {
  activity: ToolActivity;
  searchQuery: string;
  worktreePath?: string | null;
  /** Inline tool-display mode: drop the boxed chrome (border / outer
   *  margin / generous padding) so the row sits flush like its
   *  neighbours. Only consumed by the skill marker — generic tool rows
   *  pick up the compact treatment from a `.inlineTurnActivities`
   *  ancestor instead. */
  inline?: boolean;
}

interface ToolDetails {
  content: string;
  lang: string | null;
}

export function ToolActivityRow(props: ToolActivityRowProps) {
  // Skill invocations get a distinct, non-expandable presentation — a
  // "<skill> activated" marker with the wand icon — instead of the
  // generic tool row, so a glance at the transcript shows which skills
  // the agent pulled in. Dispatched here (rather than an early return
  // inside the body) so the generic row's hooks stay unconditional.
  if (isSkillActivity(props.activity)) {
    return (
      <SkillActivationRow
        activity={props.activity}
        searchQuery={props.searchQuery}
        inline={props.inline}
      />
    );
  }
  return <GenericToolActivityRow {...props} />;
}

function SkillActivationRow({
  activity,
  searchQuery,
  inline,
}: {
  activity: ToolActivity;
  searchQuery: string;
  inline?: boolean;
}) {
  const skillName = skillActivationName(activity);
  return (
    <div
      className={inline ? `${styles.skillBlock} ${styles.skillBlockInline}` : styles.skillBlock}
    >
      <div
        className={
          inline
            ? `${styles.skillActivation} ${styles.skillActivationInline}`
            : styles.skillActivation
        }
      >
        <WandSparkles
          size={13}
          aria-hidden="true"
          className={styles.skillActivationIcon}
        />
        <span className={styles.skillActivationName}>
          <HighlightedPlainText text={skillName} query={searchQuery} />
        </span>
        <span className={styles.skillActivationSuffix}> activated</span>
      </div>
    </div>
  );
}

function GenericToolActivityRow({
  activity,
  searchQuery,
  worktreePath,
}: ToolActivityRowProps) {
  const expanded = useAppStore((s) => !!s.expandedToolUseIds[activity.toolUseId]);
  const toggleToolUseExpanded = useAppStore((s) => s.toggleToolUseExpanded);
  const extendedToolCallOutput = useAppStore((s) => s.extendedToolCallOutput);
  const editSummary = summarizeToolActivityEdit(activity);
  const summary = activitySummaryText(activity);
  const details = useMemo(() => toolDetails(activity), [activity]);
  const cachedHtml = details.lang
    ? getCachedHighlight(details.content, details.lang)
    : null;
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!extendedToolCallOutput || !expanded || !details.lang || cachedHtml != null) {
      return;
    }
    let cancelled = false;
    void highlightCode(details.content, details.lang).then((html) => {
      if (!cancelled && html != null) forceUpdate();
    });
    return () => {
      cancelled = true;
    };
  }, [cachedHtml, details.content, details.lang, expanded, extendedToolCallOutput]);

  const label = `${expanded ? "Collapse" : "Expand"} ${activity.toolName} input details`;

  return (
    <div key={activity.toolUseId} className={styles.toolActivity}>
      <div className={styles.toolHeader}>
        {extendedToolCallOutput && (
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
        )}
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
      {extendedToolCallOutput && expanded && (
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
  const readableInput = input ? readableToolInput(activity.toolName, input) : null;

  if (readableInput) return readableInput;

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

function readableToolInput(
  toolName: string,
  input: Record<string, unknown>,
): ToolDetails | null {
  const normalized = toolName.toLowerCase();

  if (normalized === "edit") {
    return replacementDetails(input, {
      pathFields: ["file_path"],
      oldFields: ["old_string"],
      newFields: ["new_string"],
      oldLabel: "old_string",
      newLabel: "new_string",
    });
  }

  if (normalized === "multiedit") {
    const filePath = stringField(input, "file_path");
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (!filePath || edits.length === 0) return null;

    const lines = [`file_path: ${yamlScalar(filePath)}`, "edits:"];
    edits.forEach((edit, index) => {
      const record = recordFromUnknown(edit);
      if (!record) return;
      const oldString = stringField(record, "old_string");
      const newString = stringField(record, "new_string");
      lines.push(`  - index: ${index + 1}`);
      if (oldString !== null) appendBlock(lines, "    ", "old_string", oldString);
      if (newString !== null) appendBlock(lines, "    ", "new_string", newString);
    });
    return { content: lines.join("\n"), lang: "yaml" };
  }

  if (normalized === "write") {
    const filePath = stringField(input, "file_path");
    const content = stringField(input, "content");
    if (!filePath || content === null) return null;
    const lines = [`file_path: ${yamlScalar(filePath)}`];
    appendBlock(lines, "", "content", content);
    return { content: lines.join("\n"), lang: "yaml" };
  }

  if (normalized === "notebookedit") {
    return replacementDetails(input, {
      pathFields: ["notebook_path"],
      oldFields: ["old_source", "source"],
      newFields: ["new_source"],
      oldLabel: "old_source",
      newLabel: "new_source",
    });
  }

  if (normalized.includes("str_replace")) {
    return replacementDetails(input, {
      pathFields: ["path", "file_path"],
      oldFields: ["old_str", "old_string"],
      newFields: ["new_str", "new_string"],
      oldLabel: "old_str",
      newLabel: "new_str",
    });
  }

  const patch = patchTextFromInput(input);
  if (patch) return { content: patch, lang: "diff" };

  return null;
}

function replacementDetails(
  input: Record<string, unknown>,
  options: {
    pathFields: readonly string[];
    oldFields: readonly string[];
    newFields: readonly string[];
    oldLabel: string;
    newLabel: string;
  },
): ToolDetails | null {
  const filePath = firstStringField(input, options.pathFields);
  const oldString = firstStringField(input, options.oldFields);
  const newString = firstStringField(input, options.newFields);
  if (!filePath || (oldString === null && newString === null)) return null;

  const lines = [`file_path: ${yamlScalar(filePath)}`];
  if (oldString !== null) appendBlock(lines, "", options.oldLabel, oldString);
  if (newString !== null) appendBlock(lines, "", options.newLabel, newString);
  return { content: lines.join("\n"), lang: "yaml" };
}

function patchTextFromInput(input: Record<string, unknown>): string | null {
  for (const field of ["patch", "input", "cmd", "command"] as const) {
    const value = stringField(input, field);
    if (value && value.includes("\n") && /(?:^|\n)(diff --git|@@ |\+\+\+ |--- )/.test(value)) {
      return value;
    }
  }
  return null;
}

function appendBlock(
  lines: string[],
  indent: string,
  label: string,
  value: string,
): void {
  lines.push(`${indent}${label}: |-`);
  if (value.length === 0) return;
  for (const line of value.split("\n")) {
    lines.push(`${indent}  ${line}`);
  }
}

function firstStringField(
  input: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = stringField(input, field);
    if (value !== null) return value;
  }
  return null;
}

function stringField(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  return typeof value === "string" ? value : null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}
