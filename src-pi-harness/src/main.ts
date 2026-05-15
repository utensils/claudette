import { lstat, mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type RequestMessage = {
  id?: string;
  type: string;
  [key: string]: unknown;
};

type PendingTool = {
  resolve: (approved: boolean) => void;
};

type HarnessState = {
  cwd: string;
  session?: AgentSession;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  pendingTools: Map<string, PendingTool>;
  // True when Claudette's permission level is `full` — i.e. the user
  // ran `/permissions full` and Claudette's tools-for-level resolver
  // returned the wildcard sentinel `["*"]`. In that mode the bash /
  // write / edit tools must not bounce through Claudette's approval
  // card; matching how `--permission-mode bypassPermissions` behaves
  // for the Claude CLI harness. Re-derived in `startSession` so it
  // tracks `/permissions` toggles that trigger a sidecar respawn via
  // the `allowed_tools_changed` drift path.
  bypassPermissions: boolean;
};

const state: HarnessState = {
  cwd: process.cwd(),
  authStorage: AuthStorage.create(),
  modelRegistry: ModelRegistry.create(AuthStorage.create()),
  pendingTools: new Map(),
  bypassPermissions: false,
};

function send(message: Record<string, unknown>): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function respond(id: unknown, command: string, success: boolean, data?: unknown, error?: unknown): void {
  if (typeof id !== "string") return;
  send({
    id,
    type: "response",
    command,
    success,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error: String(error) }),
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Non-trimming string accessor for free-form prompt / steer payloads.
// `asString` is right for ids and config keys where leading/trailing
// whitespace is always noise, but trimming user prompts would silently
// drop meaningful whitespace (a turn that starts with a code-block fence,
// a deliberately blank-leading message, etc.) and diverge from how
// Claude / Codex forward prompts verbatim.
function asPromptString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function safePath(cwd: string, value: string): string {
  const root = resolve(cwd);
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value);
  assertInsideWorkspace(root, target, value);
  return target;
}

async function safeExistingPath(cwd: string, value: string): Promise<string> {
  const root = await realpath(cwd);
  const target = await realpath(safePath(cwd, value));
  assertInsideWorkspace(root, target, value);
  return target;
}

async function assertWritableTarget(cwd: string, path: string): Promise<void> {
  const root = await realpath(cwd);
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink()) {
      throw new Error(`Refusing to write through symlink: ${path}`);
    }
    assertInsideWorkspace(root, await realpath(path), path);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  assertInsideWorkspace(root, await realExistingAncestor(dirname(path)), path);
}

async function realExistingAncestor(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function assertInsideWorkspace(root: string, target: string, original: string): void {
  const rel = relative(root, target);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`Path escapes workspace: ${original}`);
}

function modelKey(
  model: { provider?: string; id?: string; name?: string; contextWindow?: number },
  authSource?: string,
) {
  const provider = model.provider ?? "pi";
  return {
    id: `${provider}/${model.id ?? model.name ?? "unknown"}`,
    provider,
    modelId: model.id ?? model.name ?? "unknown",
    label: model.name ?? model.id ?? "Unknown",
    contextWindowTokens: model.contextWindow ?? 200_000,
    // Pi's `AuthStatus.source`:
    //   "stored"      → user ran `pi auth` (auth.json)
    //   "runtime"     → CLI --api-key flag (per-process override)
    //   "environment" → matching env var (e.g. `OPENAI_API_KEY`)
    //   "fallback"    → models.json custom-provider fallback resolver
    //   "models_json_*" → bundled keys / commands inside Pi's own
    //                      models.json (the "free" providers like Owl
    //                      Alpha / Auto Router / Poolside that Pi ships)
    // We only surface providers the user actually set up — see
    // `USER_CONFIGURED_AUTH_SOURCES`.
    authSource,
  };
}

/** Auth sources that count as "the user has configured this provider".
 *  Pi's `AuthStatus.source` distinguishes:
 *   - `stored`      — auth.json (OAuth login or saved API key)
 *   - `runtime`     — `--api-key` CLI override
 *   - `environment` — env var (e.g. `ANTHROPIC_API_KEY`)
 *   - `fallback`    — custom-provider key resolved by Pi's
 *                     `setFallbackResolver` callback chain
 *   - `models_json_key` / `models_json_command` — literal/command
 *                     auth recipes embedded in `~/.pi/agent/models.json`
 *
 *  All six paths are intentional user-configured surfaces (`stored`,
 *  `runtime`, `environment` cover the standard /login flow; the
 *  `fallback` and `models_json_*` family cover Pi's custom-provider
 *  story documented at `docs/custom-provider.md`). A provider with
 *  *no* configured auth has no `source` at all and gets filtered out
 *  by `status.source ? … : false` in `isUserConfiguredProvider`,
 *  which is the actual "Pi bundled default" gate. */
const USER_CONFIGURED_AUTH_SOURCES: ReadonlySet<string> = new Set([
  "stored",
  "runtime",
  "environment",
  "fallback",
  "models_json_key",
  "models_json_command",
]);

function providerAuthSource(provider: string): string | undefined {
  // `ModelRegistry.getProviderAuthStatus` layers the `models_json_*`
  // sources on top of `AuthStorage.getAuthStatus` — without this call,
  // a Pi provider whose only credential is the key/command embedded in
  // `~/.pi/agent/models.json` reports `source: undefined` and the
  // user-configured filter drops it. Calling AuthStorage directly
  // (the previous implementation) silently hid every models.json-only
  // custom provider from the picker and Settings card.
  return state.modelRegistry.getProviderAuthStatus(provider).source;
}

function isUserConfiguredProvider(provider: string): boolean {
  if (!provider || provider === "pi") return true;
  const source = providerAuthSource(provider);
  return source ? USER_CONFIGURED_AUTH_SOURCES.has(source) : false;
}

function listAvailableModels() {
  state.modelRegistry.refresh();
  // `getAvailable()` filters by `hasAuth()` which counts *any* auth
  // source (including Pi's bundled free routes). Layer our stricter
  // user-configured filter on top so the picker / Settings card only
  // surfaces providers the user actually set up.
  return state.modelRegistry
    .getAvailable()
    .filter((model) => isUserConfiguredProvider(model.provider ?? "pi"))
    .map((model) => modelKey(model, providerAuthSource(model.provider ?? "pi")));
}

async function approval(toolCallId: string, kind: "commandExecution" | "fileChange", input: Record<string, unknown>) {
  // `/permissions full` → Claudette plumbs `allowedTools = ["*"]` into
  // `start_session`, which sets `state.bypassPermissions`. Skip the
  // approval round-trip so the user isn't asked to approve every bash
  // / write / edit when they explicitly opted out of prompts. Tool
  // execution still flows through the regular `tool_update` /
  // `tool_result` events, so the activity remains visible — only the
  // approval card is suppressed.
  if (state.bypassPermissions) return true;
  send({
    type: "tool_request",
    requestId: toolCallId,
    toolCallId,
    kind,
    input,
  });
  return new Promise<boolean>((resolveApproval) => {
    state.pendingTools.set(toolCallId, { resolve: resolveApproval });
  });
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function buildTools(cwd: string, enabledTools: readonly string[]): ToolDefinition[] {
  const enabled = new Set(enabledTools);
  const tools = [
    defineTool({
      name: "read",
      label: "Read",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: Type.Object({
        path: Type.String(),
      }),
      execute: async (_toolCallId, params) => {
        const path = await safeExistingPath(cwd, params.path);
        // Cap the file read so a stray `read` on a huge build artifact
        // (e.g. a 200 MB sourcemap, a generated SQL dump) can't push a
        // multi-megabyte tool result through the sidecar protocol and
        // straight into the provider's context window. **Stat first**:
        // doing `readFile` on a multi-GB file would allocate the whole
        // thing in memory before we ever get to truncate, OOMing or
        // stalling the sidecar. Only files within the cap go through
        // `readFile`; over-cap files are read up to the cap via a file
        // handle and the result is reported as truncated.
        const fileStat = await stat(path);
        if (fileStat.size <= MAX_READ_BYTES) {
          const text = await readFile(path, "utf8");
          return textResult(text, { path });
        }
        const fd = await open(path, "r");
        try {
          const buf = Buffer.alloc(MAX_READ_BYTES);
          const { bytesRead } = await fd.read(buf, 0, MAX_READ_BYTES, 0);
          const head = buf.subarray(0, bytesRead).toString("utf8");
          // Drop a trailing U+FFFD if the cap landed mid-codepoint, so
          // the model doesn't see a synthetic replacement char.
          const safeHead = head.endsWith("�") ? head.slice(0, -1) : head;
          const dropped = fileStat.size - bytesRead;
          return textResult(
            safeHead +
              `\n\n... [truncated: ${dropped} more bytes; tool limit ${MAX_READ_BYTES} bytes] ...\n`,
            {
              path,
              truncated: true,
              sizeBytes: fileStat.size,
              limitBytes: MAX_READ_BYTES,
            },
          );
        } finally {
          await fd.close();
        }
      },
    }),
    defineTool({
      name: "ls",
      label: "List",
      description: "List files in a directory.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const path = await safeExistingPath(cwd, params.path ?? ".");
        const entries = await readdir(path, { withFileTypes: true });
        return textResult(
          entries
            .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
            .join("\n"),
          { path },
        );
      },
    }),
    defineTool({
      name: "find",
      label: "Find",
      description: "Find files whose name contains a query string.",
      parameters: Type.Object({
        query: Type.String(),
        path: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      execute: async (_toolCallId, params) => {
        const root = await safeExistingPath(cwd, params.path ?? ".");
        const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
        const matches: string[] = [];
        async function walk(dir: string): Promise<void> {
          if (matches.length >= limit) return;
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.name.includes(params.query)) matches.push(path);
            if (
              entry.isDirectory() &&
              !entry.name.startsWith(".") &&
              !FIND_SKIP_DIRS.has(entry.name) &&
              matches.length < limit
            ) {
              await walk(path);
            }
          }
        }
        await walk(root);
        return textResult(matches.join("\n"), { root, query: params.query });
      },
    }),
    defineTool({
      name: "grep",
      label: "Grep",
      description: "Search text files for a query.",
      parameters: Type.Object({
        query: Type.String(),
        path: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params, signal) => {
        const root = await safeExistingPath(cwd, params.path ?? ".");
        try {
          const result = await runCommand("rg", ["-n", "--", params.query, root], cwd, signal);
          return textResult(result.stdout || result.stderr, {
            command: `rg -n -- ${params.query} ${root}`,
            exitCode: result.exitCode,
            ...(result.truncated
              ? { truncated: true, limitBytes: result.limitBytes }
              : {}),
          });
        } catch (error) {
          if (!isMissingCommand(error)) throw error;
          return textResult(await grepFallback(root, params.query), {
            command: `builtin grep ${params.query} ${root}`,
            exitCode: 0,
          });
        }
      },
    }),
    defineTool({
      name: "bash",
      label: "Bash",
      description: "Run a shell command after Claudette approval.",
      parameters: Type.Object({
        command: Type.String(),
      }),
      execute: async (toolCallId, params, signal) => {
        const approved = await approval(toolCallId, "commandExecution", {
          command: params.command,
          cwd,
          reason: "Pi requested command execution.",
        });
        if (!approved) throw new Error("Command denied by user.");
        const result = await runCommand(shellProgram(), shellArgs(params.command), cwd, signal);
        const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return textResult(text, {
          command: params.command,
          exitCode: result.exitCode,
          ...(result.truncated
            ? { truncated: true, limitBytes: result.limitBytes }
            : {}),
        });
      },
    }),
    defineTool({
      name: "write",
      label: "Write",
      description: "Write a UTF-8 text file after Claudette approval.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
      }),
      execute: async (toolCallId, params) => {
        const path = safePath(cwd, params.path);
        await assertWritableTarget(cwd, path);
        // Surface the proposed content in the approval payload so the
        // Claudette permission card can render it for review. Without
        // this, the user is asked to approve a mutation knowing only the
        // path — defeating the audit purpose of the prompt.
        const approved = await approval(toolCallId, "fileChange", {
          path,
          operation: "write",
          newText: params.content,
          reason: "Pi requested a file write.",
        });
        if (!approved) throw new Error("Write denied by user.");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, params.content, "utf8");
        return textResult(`Wrote ${path}`, { path });
      },
    }),
    defineTool({
      name: "edit",
      label: "Edit",
      description: "Replace text in a UTF-8 file after Claudette approval.",
      parameters: Type.Object({
        path: Type.String(),
        oldText: Type.String(),
        newText: Type.String(),
      }),
      prepareArguments: (args) => {
        const input = (args ?? {}) as Record<string, unknown>;
        return {
          path: typeof (input.path ?? input.file_path) === "string" ? String(input.path ?? input.file_path) : "",
          oldText: typeof (input.oldText ?? input.old_text) === "string" ? String(input.oldText ?? input.old_text) : "",
          newText: typeof (input.newText ?? input.new_text) === "string" ? String(input.newText ?? input.new_text) : "",
        };
      },
      execute: async (toolCallId, params) => {
        const path = safePath(cwd, params.path);
        await assertWritableTarget(cwd, path);
        if (!params.oldText) {
          throw new Error("Edit requires non-empty oldText.");
        }
        // Send the proposed replacement to Claudette so the permission
        // card can render a diff. The frontend already handles diff-like
        // approval payloads from other harnesses; without this, the user
        // is asked to approve a mutation they cannot inspect.
        const approved = await approval(toolCallId, "fileChange", {
          path,
          operation: "edit",
          oldText: params.oldText,
          newText: params.newText,
          reason: "Pi requested a file edit.",
        });
        if (!approved) throw new Error("Edit denied by user.");
        const before = await readFile(path, "utf8");
        if (!before.includes(params.oldText)) {
          throw new Error(`Text to replace was not found in ${path}`);
        }
        await writeFile(path, before.replace(params.oldText, params.newText), "utf8");
        return textResult(`Edited ${path}`, { path });
      },
    }),
  ];
  return tools.filter((tool) => enabled.has(tool.name));
}

function shellProgram(): string {
  return process.platform === "win32" ? "cmd.exe" : "sh";
}

function shellArgs(command: string): string[] {
  return process.platform === "win32" ? ["/S", "/C", command] : ["-c", command];
}

/** Hard ceilings on tool result sizes. These cap the bytes routed
 *  through the sidecar's JSONL protocol so a runaway file read or shell
 *  command can't OOM the harness, balloon the chat transcript, or push
 *  tens of MB into the next provider request as tool input. The reads
 *  themselves are still streamed normally; we just truncate the buffer
 *  that gets returned to the agent. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1 * 1024 * 1024;

/** Directories the `find` tool refuses to recurse into. These are the
 *  classic dependency / build caches whose contents are noise for an
 *  agent search and whose size dominates real source code 1000:1 on
 *  most workspaces. */
const FIND_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** Per-stream byte-capped UTF-8 accumulator used by `runCommand`. The
 *  chunks we get from `setEncoding("utf8")` are JS strings (UTF-16
 *  units), so `chunk.length` is the wrong axis to compare against a
 *  byte cap — heavily multi-byte output would overshoot the named
 *  limit by 2–4×. Convert to UTF-8 bytes for the budget check, and
 *  when a chunk overflows the remaining room, re-slice on the byte
 *  buffer and drop a trailing replacement char if we landed mid-
 *  codepoint. */
function makeStreamCapture(limitBytes: number) {
  let bytes = 0;
  let truncated = false;
  const chunks: string[] = [];
  return {
    push(chunk: string): void {
      if (bytes >= limitBytes) {
        truncated = true;
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      const room = limitBytes - bytes;
      if (chunkBytes > room) {
        const buf = Buffer.from(chunk, "utf8");
        const head = buf.subarray(0, room).toString("utf8");
        const safeHead = head.endsWith("�") ? head.slice(0, -1) : head;
        chunks.push(safeHead);
        bytes = limitBytes;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunkBytes;
    },
    text(): string {
      return chunks.join("");
    },
    wasTruncated(): boolean {
      return truncated;
    },
  };
}

function runCommand(program: string, args: string[], cwd: string, signal?: AbortSignal) {
  return new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    truncated?: boolean;
    limitBytes?: number;
  }>((resolveCommand, reject) => {
    const child = spawn(program, args, { cwd, signal });
    const stdout = makeStreamCapture(MAX_COMMAND_OUTPUT_BYTES);
    const stderr = makeStreamCapture(MAX_COMMAND_OUTPUT_BYTES);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolveCommand({
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        truncated: stdout.wasTruncated() || stderr.wasTruncated(),
        limitBytes: MAX_COMMAND_OUTPUT_BYTES,
      }),
    );
  });
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Per-file size cap for the no-`rg` grep fallback. The fallback reads
 *  each candidate fully into memory because `String.includes` works on
 *  the whole text; without a cap, decoding a single multi-hundred-MB
 *  generated file as UTF-8 can allocate enough to stall or OOM the
 *  sidecar. 4 MB is well above any realistic source file but small
 *  enough that the worst-case allocation is bounded. */
const GREP_FALLBACK_MAX_FILE_BYTES = 4 * 1024 * 1024;

async function grepFallback(root: string, query: string): Promise<string> {
  const matches: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (matches.length >= 500) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (matches.length >= 500) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
          await walk(path);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        // Stat first so a single huge file (a sourcemap, a generated
        // build artifact, a binary mis-decoded as text) can't pull
        // hundreds of MB through `readFile` ahead of the per-tool cap.
        const info = await stat(path);
        if (info.size > GREP_FALLBACK_MAX_FILE_BYTES) continue;
        const text = await readFile(path, "utf8");
        text.split(/\r?\n/).forEach((line, index) => {
          if (matches.length < 500 && line.includes(query)) {
            matches.push(`${path}:${index + 1}:${line}`);
          }
        });
      } catch {
        // Ignore unreadable or non-UTF-8 files in the fallback scanner.
      }
    }
  }
  await walk(root);
  return matches.join("\n");
}

function mapPermissionTools(value: unknown): { tools: string[]; bypass: boolean } {
  const tools = asStringArray(value);
  if (tools.includes("*")) {
    return { tools: ["read", "ls", "find", "grep", "bash", "write", "edit"], bypass: true };
  }
  const out = new Set<string>();
  for (const tool of tools) {
    const normalized = tool.toLowerCase();
    if (normalized === "read") out.add("read");
    if (normalized === "grep") out.add("grep");
    if (normalized === "glob") out.add("find");
    if (normalized === "write") out.add("write");
    if (normalized === "edit") out.add("edit");
    if (normalized === "bash") out.add("bash");
  }
  out.add("ls");
  return { tools: [...out], bypass: false };
}

/**
 * Mirror Claudette's `pi_provider_override` payload onto Pi's
 * `ModelRegistry.registerProvider` API. The payload arrives JSON-shaped
 * from Rust (`providerOverride` field of the `start_session` message);
 * skip silently when absent or malformed so a release that doesn't
 * pass the override still works.
 */
function applyProviderOverride(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const value = raw as Record<string, unknown>;
  const provider = asString(value.provider);
  const baseUrl = asString(value.baseUrl);
  const modelId = asString(value.modelId);
  if (!provider || !baseUrl || !modelId) return;
  const modelLabel = asString(value.modelLabel) ?? modelId;
  const contextRaw = value.contextWindow;
  // `contextWindow = 0` is Claudette's "use Pi's default" signal —
  // forward a generous fallback so the agent loop doesn't reject the
  // model for a missing window value.
  const contextWindow =
    typeof contextRaw === "number" && contextRaw > 0
      ? Math.floor(contextRaw)
      : 200_000;
  try {
    state.modelRegistry.registerProvider(provider, {
      baseUrl,
      // OpenAI-style endpoints. Ollama and LM Studio both speak the
      // OpenAI chat completions API at the path we receive.
      api: "openai",
      // No API key required for local servers — Ollama accepts any
      // bearer and LM Studio ignores it. Set a placeholder so Pi's
      // auth-status check doesn't filter the provider out as
      // "unconfigured".
      apiKey: "claudette-local",
      models: [
        {
          id: modelId,
          name: modelLabel,
          reasoning: false,
          input: ["text"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow,
          maxTokens: Math.min(contextWindow, 32_768),
        },
      ],
    });
  } catch (err) {
    // Don't crash the start path on an override the SDK rejects —
    // `findModel` will surface a useful error a few lines down if the
    // provider truly isn't reachable.
    process.stderr.write(
      `pi-harness: registerProvider(${provider}) failed: ${String(err)}\n`,
    );
  }
}

async function startSession(message: RequestMessage): Promise<void> {
  const cwd = asString(message.cwd) ?? process.cwd();
  const agentDir = asString(message.agentDir) ?? getAgentDir();
  const sessionDir = asString(message.sessionDir);
  const requestedSessionId = asString(message.sessionId);
  const requestedModel = asString(message.model);
  const customInstructions = asString(message.customInstructions);
  const permissionTools = mapPermissionTools(message.allowedTools);
  const tools = permissionTools.tools;
  state.cwd = cwd;
  state.authStorage = AuthStorage.create();
  state.modelRegistry = ModelRegistry.create(state.authStorage);
  // Re-derive the bypass flag on every (re)start so a `/permissions
  // full` ↔ `/permissions standard` toggle — which `chat::send` already
  // honors by tearing down the persistent Pi process — applies on the
  // next turn without needing a separate set_permission_level message.
  state.bypassPermissions = permissionTools.bypass;

  // Claudette can hand us a one-shot provider definition for the
  // user's local Ollama / LM Studio server (anything Pi doesn't ship
  // a bundled provider for). Apply it *before* `findModel` so the
  // qualified id the agent loop will look up resolves cleanly.
  // Without this an upgrading user who picked `ollama/llama3` in the
  // Ollama card would get "model not found in the SDK registry" even
  // though Claudette's own probe knows the server.
  applyProviderOverride(message.providerOverride);

  let model: Awaited<ReturnType<typeof findModel>> | undefined = undefined;
  if (requestedModel) {
    model = findModel(requestedModel);
    if (!model) {
      // Fail fast instead of letting the SDK silently fall back to its
      // own default model — the user picked a model that doesn't exist
      // in this Pi registry, and pretending it does would run a
      // different model than Claudette displays.
      throw new Error(
        `Pi model "${requestedModel}" was not found in the SDK registry. Click "Refresh models" on the Pi card, then retry.`,
      );
    }
  }

  // Identity preface for the session's system prompt. Pi sessions can
  // run any provider's model (qwen via Ollama, GPT via OpenAI, Anthropic
  // via api.anthropic.com, etc.). Without an explicit identity line the
  // model is left to guess "what LLM am I?" — and guesses often land on
  // whatever brand showed up most in its training data ("Claude Code",
  // "ChatGPT"), which is wrong here. Pin the actual model id when we
  // know it; fall back to a generic Pi identity when the SDK is choosing
  // the model on our behalf.
  const piIdentity = [
    "You are an AI coding agent running inside Claudette, dispatched through the Pi SDK harness.",
    model?.id
      ? `Your underlying model is "${model.id}". If asked "what LLM are you" or any equivalent identity question, answer truthfully with that model id and the Pi harness — do not claim to be Claude, ChatGPT, or any other product.`
      : "If asked what model or LLM you are, say so plainly rather than guessing — do not claim to be Claude or ChatGPT.",
    "Use the available tools normally; Claudette will ask the user for approval before mutating commands or file changes.",
  ].join(" ");

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPromptOverride: (basePrompt: string[]) => [
      ...basePrompt,
      ...(customInstructions ? [customInstructions] : []),
      piIdentity,
    ],
  });
  await resourceLoader.reload();
  // Claudette reuses the same `sessionDir` for every turn in a chat
  // session — both within an app run and across restarts. With
  // `SessionManager.create` the SDK always opens a fresh transcript
  // file, so a resumed chat looks like a brand-new conversation to
  // the model (no prior context). `continueRecent` loads the most
  // recent session in `sessionDir` when one exists and falls back to
  // creating a new one when the directory is empty, which matches
  // both the first-turn and resume cases without an explicit "is
  // this a resume?" signal from Rust.
  const manager = sessionDir
    ? SessionManager.continueRecent(cwd, sessionDir)
    : SessionManager.inMemory();
  const result = await createAgentSession({
    cwd,
    agentDir,
    authStorage: state.authStorage,
    modelRegistry: state.modelRegistry,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    model,
    thinkingLevel: normalizeThinking(message.thinkingLevel),
    noTools: "builtin",
    tools,
    customTools: buildTools(cwd, tools),
  });

  state.session?.dispose();
  state.session = result.session;
  state.session.subscribe((event) => routeSessionEvent(event));
  // Echo Claudette's session id back when it sent one. The chat bridge
  // treats the ready event's `sessionId` as canonical and uses it to
  // build `pi-sessions/<id>` on the next start. If we reported the SDK's
  // own generated id here, the next start would look in a different
  // directory and lose the prior transcript. Falling back to the SDK id
  // preserves the standalone/test paths that don't pre-allocate one.
  send({
    type: "ready",
    sessionId: requestedSessionId ?? state.session.sessionId,
    sessionFile: state.session.sessionFile,
    model: state.session.model ? modelKey(state.session.model) : null,
  });
}

function normalizeThinking(value: unknown) {
  const level = asString(value);
  if (level === "off" || level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh") {
    return level;
  }
  return undefined;
}

function findModel(value: string) {
  state.modelRegistry.refresh();
  const [provider, ...idParts] = value.includes("/") ? value.split("/") : ["", value];
  const modelId = idParts.join("/");
  if (provider) return state.modelRegistry.find(provider, modelId);
  return state.modelRegistry.getAll().find((model) => model.id === modelId);
}

function routeSessionEvent(event: AgentSessionEvent): void {
  switch (event.type) {
    // Pi distinguishes the agent-loop boundary (`agent_start` /
    // `agent_end`, fired once per `send_turn`) from each internal LLM
    // turn (`turn_start` / `turn_end`, fired N times when the agent
    // tool-calls itself across multiple LLM rounds). Claudette's
    // protocol expects exactly one `turn_start` + one `turn_end` per
    // user prompt — collapse onto the agent-loop boundary and ignore
    // the per-LLM-turn events so a multi-round agent doesn't emit N
    // duplicate `Result` events on the Rust side.
    case "agent_start":
      send({ type: "turn_start" });
      break;
    case "message_update": {
      const update = event.assistantMessageEvent as { type?: string; delta?: string; text?: string };
      // Pi SDK `AssistantMessageEvent` is a tagged union covering text,
      // thinking, and tool-call streaming. Each tool call streams its
      // raw JSON arguments as a series of `toolcall_delta` events; if
      // we forwarded those as `assistant_delta`, Claudette would render
      // them as user-visible chat text (the bug surfaces as a run of
      // `{"path":"…"}{"path":"…"}` strings appearing above the tool
      // calls section when a Pi model fans out multiple reads). Tool
      // execution is reported separately via `tool_execution_*`, so
      // every `toolcall_*` variant here is intentionally discarded.
      // Only `text_delta` becomes assistant text; the thinking deltas
      // route to the dedicated thinking stream.
      const type = update.type;
      if (type === "thinking_delta" || type === "reasoning_delta") {
        const delta = update.delta ?? update.text ?? "";
        if (delta) send({ type: "thinking_delta", delta });
        break;
      }
      if (type === "text_delta") {
        const delta = update.delta ?? update.text ?? "";
        if (delta) send({ type: "assistant_delta", delta });
        break;
      }
      // start / text_start / text_end / thinking_start / thinking_end /
      // toolcall_start / toolcall_delta / toolcall_end / done / error
      // carry no user-visible chat text — drop them.
      break;
    }
    case "tool_execution_start":
      send({
        type: "tool_update",
        phase: "start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      break;
    case "tool_execution_update":
      send({
        type: "tool_update",
        phase: "update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.partialResult,
      });
      break;
    case "tool_execution_end":
      send({
        type: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
      break;
    case "agent_end":
      send({
        type: "turn_end",
        error: "errorMessage" in event ? event.errorMessage : undefined,
      });
      break;
    // Per-LLM-turn boundaries fire N times inside the agent loop —
    // intentionally swallowed here (see the `agent_start` case for
    // the full rationale). Listed explicitly so a future SDK upgrade
    // that adds new event types fails the exhaustiveness check at
    // the `default` branch instead of accidentally re-introducing
    // the double-Result bug.
    case "turn_start":
    case "turn_end":
    case "auto_retry_start":
    case "compaction_start":
    case "compaction_end":
    case "queue_update":
    case "session_info_changed":
    case "thinking_level_changed":
    case "auto_retry_end":
      break;
    default:
      break;
  }
}

function runTurn(task: Promise<unknown>): void {
  void task.catch((error) => {
    const message = String(error);
    send({ type: "error", error: message });
    send({ type: "turn_end", error: message });
  });
}

async function handle(message: RequestMessage): Promise<void> {
  switch (message.type) {
    case "initialize":
      respond(message.id, message.type, true, { version: "0.74.0" });
      break;
    case "start_session":
      await startSession(message);
      respond(message.id, message.type, true);
      break;
    case "prompt":
      if (!state.session) throw new Error("Pi session has not started");
      runTurn(state.session.prompt(asPromptString(message.prompt) ?? ""));
      respond(message.id, message.type, true);
      break;
    case "steer":
      if (!state.session) throw new Error("Pi session has not started");
      runTurn(state.session.steer(asPromptString(message.prompt) ?? ""));
      respond(message.id, message.type, true);
      break;
    case "abort":
      // Resolve any pending approval prompts so the corresponding
      // tool `execute()` calls don't keep awaiting after Pi has been
      // told to stop. Without this, an in-flight bash/write/edit
      // prompt would block the agent's abort propagation.
      for (const pending of state.pendingTools.values()) {
        pending.resolve(false);
      }
      state.pendingTools.clear();
      await state.session?.abort();
      respond(message.id, message.type, true);
      break;
    case "set_model": {
      if (!state.session) throw new Error("Pi session has not started");
      const model = findModel(asString(message.model) ?? "");
      if (!model) throw new Error(`Pi model not found: ${String(message.model)}`);
      await state.session.setModel(model);
      respond(message.id, message.type, true, modelKey(model));
      break;
    }
    case "discover_models":
      respond(message.id, message.type, true, { models: listAvailableModels() });
      break;
    case "auth_status":
      respond(message.id, message.type, true, {
        models: listAvailableModels().length,
        authFile: join(getAgentDir(), "auth.json"),
      });
      break;
    case "approve_tool": {
      const requestId = asString(message.requestId);
      const pending = requestId ? state.pendingTools.get(requestId) : undefined;
      if (requestId) state.pendingTools.delete(requestId);
      pending?.resolve(true);
      respond(message.id, message.type, true);
      break;
    }
    case "deny_tool": {
      const requestId = asString(message.requestId);
      const pending = requestId ? state.pendingTools.get(requestId) : undefined;
      if (requestId) state.pendingTools.delete(requestId);
      pending?.resolve(false);
      respond(message.id, message.type, true);
      break;
    }
    case "dispose":
      state.session?.dispose();
      state.session = undefined;
      respond(message.id, message.type, true);
      break;
    default:
      throw new Error(`Unknown request type ${message.type}`);
  }
}

async function main(): Promise<void> {
  try {
    await stat(process.cwd());
  } catch {
    process.chdir("/");
  }

  const rl = createInterface({ input });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: RequestMessage;
    try {
      message = JSON.parse(trimmed) as RequestMessage;
    } catch (error) {
      send({ type: "error", error: `Invalid JSON: ${String(error)}` });
      continue;
    }
    try {
      await handle(message);
    } catch (error) {
      send({ type: "error", requestId: message.id, error: String(error) });
      respond(message.id, message.type, false, undefined, error);
    }
  }
}

main().catch((error) => {
  send({ type: "exit", error: String(error) });
  process.exitCode = 1;
});
