/**
 * Per-tool display metadata: which input field carries the "primary
 * content" worth surfacing in the chat tool-call row, and what
 * syntax-highlighting language that content should be rendered as.
 *
 * Three resolution layers, applied in order:
 *
 *   1. **Exact name match** in `TOOL_METADATA` — built-in tools
 *      (`Bash`, `Read`, …) plus well-known MCP servers
 *      (`mcp__postgres__query`, `mcp__playwright__browser_evaluate`, …)
 *      where we know which input field carries the user-facing payload
 *      and what language to highlight it as.
 *
 *   2. **Tool-name heuristics** — pattern matches on the tool name
 *      (e.g. `mcp__*__query` strongly implies SQL; anything containing
 *      `bash` or `shell` implies a shell command). Lets new MCP servers
 *      that follow common naming conventions render correctly without
 *      a registry entry.
 *
 *   3. **Field-name heuristics** — examine the parsed input's keys for
 *      well-known content fields (`sql`, `code`, `command`, `prompt`,
 *      …). The first match wins, with the language inferred from the
 *      field name when possible. If no known field matches, fall back
 *      to the longest string-valued field in the input.
 *
 * The previous implementation in `extractToolSummary` (now a thin
 * wrapper around `resolveToolSummary`) only checked four MCP fields
 * (`description`, `url`, `query`, `command`), so common MCP tools like
 * `mcp__postgres__query` (which uses an `sql` field) silently fell
 * through to an empty summary. This module exists to fix that hole
 * once and for all by treating MCP tool naming as data, not code.
 */

export interface ToolDisplayMeta {
  /** Input field whose value is the primary content to surface as
   *  the tool-call summary. Must be a string-valued field. */
  contentField: string;
  /** Optional Shiki language id for highlighting the field's value
   *  when rendered as a code block. `null` / absent renders plain. */
  contentLang?: string | null;
}

/**
 * Exact-match registry. Keep entries terse — one line per tool — and
 * group by source (built-ins, then alphabetical MCP). Add new MCP
 * tools as you encounter them; for tools that follow a common naming
 * convention, the heuristics below will usually surface a reasonable
 * default without a manual entry.
 */
export const TOOL_METADATA: Readonly<Record<string, ToolDisplayMeta>> = {
  // Built-in Claude tools
  Bash: { contentField: "command", contentLang: "bash" },
  Read: { contentField: "file_path" },
  Edit: { contentField: "file_path" },
  Write: { contentField: "file_path" },
  Glob: { contentField: "pattern" },
  Grep: { contentField: "pattern" },
  WebFetch: { contentField: "url" },
  WebSearch: { contentField: "query" },
  NotebookEdit: { contentField: "notebook_path" },
  Agent: { contentField: "description" },
  Skill: { contentField: "skill" },
  AskUserQuestion: { contentField: "question" },
  TodoWrite: { contentField: "todos" }, // array; renderer falls back to count
  ToolSearch: { contentField: "query" },
  CronCreate: { contentField: "schedule" },

  // Well-known MCP servers — postgres / sqlite
  mcp__postgres__query: { contentField: "sql", contentLang: "sql" },
  mcp__postgres__execute: { contentField: "sql", contentLang: "sql" },
  mcp__postgres__statement: { contentField: "sql", contentLang: "sql" },
  mcp__sqlite__query: { contentField: "sql", contentLang: "sql" },
  mcp__sqlite__execute: { contentField: "sql", contentLang: "sql" },
  mcp__mysql__query: { contentField: "sql", contentLang: "sql" },
  mcp__bigquery__query: { contentField: "query", contentLang: "sql" },
  mcp__redshift__query: { contentField: "sql", contentLang: "sql" },

  // Playwright / browser MCP
  mcp__plugin_playwright__browser_evaluate: {
    contentField: "function",
    contentLang: "javascript",
  },
  mcp__plugin_playwright__browser_run_code_unsafe: {
    contentField: "code",
    contentLang: "javascript",
  },
  mcp__plugin_playwright__browser_navigate: { contentField: "url" },
  mcp__plugin_playwright__browser_click: { contentField: "element" },
  mcp__plugin_playwright__browser_fill_form: { contentField: "fields" },
  mcp__plugin_playwright__browser_type: { contentField: "text" },

  // GitHub / GitLab / git MCP
  mcp__github__create_issue: { contentField: "title" },
  mcp__github__create_pull_request: { contentField: "title" },
  mcp__github__search_code: { contentField: "q" },
  mcp__github__search_issues: { contentField: "q" },
  mcp__github__get_issue: { contentField: "issue_number" },

  // Filesystem MCP
  mcp__filesystem__read_file: { contentField: "path" },
  mcp__filesystem__write_file: { contentField: "path" },
  mcp__filesystem__list_directory: { contentField: "path" },
  mcp__filesystem__search_files: { contentField: "pattern" },

  // Fetch / HTTP MCP
  mcp__fetch__fetch: { contentField: "url" },

  // Memory / knowledge-graph MCP
  mcp__memory__create_entities: { contentField: "entities" },
  mcp__memory__search_nodes: { contentField: "query" },
};

/**
 * Tool-name heuristics. Each rule is a `(predicate, meta)` pair; the
 * first matching rule wins. Order matters — more specific patterns
 * (longer suffixes) before generic ones. Rules can omit `contentLang`
 * to defer to field-name heuristics for the language.
 */
const TOOL_NAME_HEURISTICS: ReadonlyArray<{
  test: (toolName: string) => boolean;
  meta: ToolDisplayMeta;
}> = [
  // Anything that looks like a SQL-flavored MCP tool — server name
  // contains "postgres"/"mysql"/"sqlite"/"redshift"/"bigquery" or the
  // operation suffix is "_query"/"_sql"/"_execute". These reliably
  // carry a SQL string in `sql` (or `query`).
  {
    test: (n) =>
      n.startsWith("mcp__") &&
      /(postgres|mysql|mariadb|sqlite|redshift|bigquery|snowflake|clickhouse|duckdb)/.test(
        n,
      ),
    meta: { contentField: "sql", contentLang: "sql" },
  },
  {
    test: (n) => n.startsWith("mcp__") && /__(query|sql|execute)$/.test(n),
    meta: { contentField: "sql", contentLang: "sql" },
  },

  // Browser automation / JS evaluation
  {
    test: (n) => n.startsWith("mcp__") && /__(evaluate|run_code|exec_js)/.test(n),
    meta: { contentField: "code", contentLang: "javascript" },
  },

  // Shell / bash MCP
  {
    test: (n) => n.startsWith("mcp__") && /(shell|bash|exec|cmd)/.test(n),
    meta: { contentField: "command", contentLang: "bash" },
  },
];

/**
 * Field-name heuristics for unknown tools. Each entry is `(fieldName,
 * lang)`. The first field present in the input that matches an entry
 * wins; later entries are tie-broken by registry order. If no known
 * field matches, callers fall back to the longest string-valued field.
 */
const FIELD_NAME_HEURISTICS: ReadonlyArray<[field: string, lang: string | null]> = [
  ["sql", "sql"],
  ["code", "javascript"],
  ["function", "javascript"],
  ["script", "javascript"],
  ["command", "bash"],
  ["cmd", "bash"],
  ["prompt", null],
  ["query", null],
  ["text", null],
  ["body", null],
  ["title", null],
  ["description", null],
  ["url", null],
  ["uri", null],
  ["path", null],
  ["file_path", null],
  ["name", null],
  ["q", null],
  ["pattern", null],
];

const MAX_SUMMARY_LENGTH = 120;

/** Resolved tool-display payload — what the renderer needs to draw a
 *  row's summary plus optionally an expanded code block. */
export interface ResolvedToolDisplay {
  /** Single-line summary, truncated to `MAX_SUMMARY_LENGTH`. May be
   *  empty if the input contained no string-valued fields and no
   *  registry entry pointed at one. */
  summary: string;
  /** Shiki language id when the summary's source field carries
   *  highlightable code. `null` → render as plain text. */
  lang: string | null;
  /** The full untruncated string the summary was derived from, for
   *  use by future expand-to-detail views. May equal `summary` when
   *  the underlying value was already short. */
  fullContent: string;
}

const EMPTY_DISPLAY: ResolvedToolDisplay = {
  summary: "",
  lang: null,
  fullContent: "",
};

/**
 * Resolve a tool's input JSON into a display-ready summary. Pure —
 * safe to call from render. Errors during JSON parse return an empty
 * display rather than throwing; callers render an empty summary cell.
 */
export function resolveToolSummary(
  toolName: string,
  inputJson: string,
): ResolvedToolDisplay {
  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch {
    return EMPTY_DISPLAY;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return EMPTY_DISPLAY;
  }
  const record = input as Record<string, unknown>;

  // Layer 1: exact-name registry.
  const exact = TOOL_METADATA[toolName];
  if (exact) {
    const display = displayFromField(record, exact.contentField, exact.contentLang ?? null);
    if (display) return display;
  }

  // Layer 2: tool-name heuristics.
  for (const rule of TOOL_NAME_HEURISTICS) {
    if (!rule.test(toolName)) continue;
    const display = displayFromField(
      record,
      rule.meta.contentField,
      rule.meta.contentLang ?? null,
    );
    if (display) return display;
  }

  // Layer 3: field-name heuristics. First well-known field wins.
  for (const [field, lang] of FIELD_NAME_HEURISTICS) {
    const display = displayFromField(record, field, lang);
    if (display) return display;
  }

  // Layer 4: longest string-valued field. Last-ditch heuristic so a
  // brand-new MCP tool with an unfamiliar schema still shows
  // *something* rather than an empty cell.
  const fallback = longestStringField(record);
  if (fallback) {
    return {
      summary: truncate(fallback, MAX_SUMMARY_LENGTH),
      lang: null,
      fullContent: fallback,
    };
  }

  return EMPTY_DISPLAY;
}

function displayFromField(
  record: Record<string, unknown>,
  field: string,
  lang: string | null,
): ResolvedToolDisplay | null {
  if (!(field in record)) return null;
  const raw = record[field];
  // Arrays/objects: special-case `todos` (count) and arrays-of-strings;
  // otherwise JSON-stringify so the summary is at least informative.
  if (Array.isArray(raw)) {
    if (field === "todos") {
      return {
        summary: `${raw.length} item${raw.length !== 1 ? "s" : ""}`,
        lang: null,
        fullContent: safeStringify(raw),
      };
    }
    const joined = raw
      .map((v) => (typeof v === "string" ? v : safeStringify(v)))
      .join(", ");
    return {
      summary: truncate(joined, MAX_SUMMARY_LENGTH),
      lang,
      fullContent: joined,
    };
  }
  if (typeof raw === "string") {
    return {
      summary: truncate(raw, MAX_SUMMARY_LENGTH),
      lang,
      fullContent: raw,
    };
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    const text = String(raw);
    return { summary: text, lang: null, fullContent: text };
  }
  if (raw == null) return null;
  // Object value: stringify it so the user gets some signal.
  const stringified = safeStringify(raw);
  return {
    summary: truncate(stringified, MAX_SUMMARY_LENGTH),
    lang: lang === "sql" ? null : lang, // SQL highlighting on JSON looks wrong
    fullContent: stringified,
  };
}

function longestStringField(record: Record<string, unknown>): string | null {
  let best: string | null = null;
  for (const value of Object.values(record)) {
    if (typeof value !== "string") continue;
    if (best === null || value.length > best.length) best = value;
  }
  return best;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}
