import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
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
};

const state: HarnessState = {
  cwd: process.cwd(),
  authStorage: AuthStorage.create(),
  modelRegistry: ModelRegistry.create(AuthStorage.create()),
  pendingTools: new Map(),
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
 *  Anything outside this set (notably `fallback` and the
 *  `models_json_*` family) is treated as a Pi-bundled default and
 *  filtered out of the model picker / Settings card so the user only
 *  sees providers they actually enabled. */
const USER_CONFIGURED_AUTH_SOURCES: ReadonlySet<string> = new Set([
  "stored",
  "runtime",
  "environment",
]);

function isUserConfiguredProvider(provider: string): boolean {
  if (!provider || provider === "pi") return true;
  // `AuthStorage.getAuthStatus` already inspects auth.json, runtime
  // overrides, env vars, and the fallback resolver in one shot, so we
  // don't need to re-check each surface ourselves.
  const status = state.authStorage.getAuthStatus(provider);
  return status.source ? USER_CONFIGURED_AUTH_SOURCES.has(status.source) : false;
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
    .map((model) =>
      modelKey(
        model,
        state.authStorage.getAuthStatus(model.provider ?? "pi").source,
      ),
    );
}

async function approval(toolCallId: string, kind: "commandExecution" | "fileChange", input: Record<string, unknown>) {
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
        // straight into the provider's context window. Truncate at the
        // cap and tell the model that's what happened so it can either
        // ask for a slice or move on.
        const text = await readFile(path, "utf8");
        const { content, truncated, limitBytes, actualBytes } =
          capTextForTool(text, MAX_READ_BYTES);
        return textResult(content, {
          path,
          ...(truncated
            ? { truncated: true, sizeBytes: actualBytes, limitBytes }
            : {}),
        });
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

function capTextForTool(
  text: string,
  limitBytes: number,
): { content: string; truncated: boolean; limitBytes: number; actualBytes: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= limitBytes) {
    return {
      content: text,
      truncated: false,
      limitBytes,
      actualBytes: buf.length,
    };
  }
  // Slice on the byte buffer but rebuild from utf8 so a multi-byte
  // codepoint at the boundary doesn't produce a replacement char in
  // the truncated tail. `toString("utf8")` with `lossless` semantics
  // is safe here because we then drop the final character to avoid
  // emitting a partial sequence.
  const head = buf.subarray(0, limitBytes).toString("utf8");
  const safeHead = head.endsWith("�") ? head.slice(0, -1) : head;
  const dropped = buf.length - limitBytes;
  return {
    content:
      safeHead +
      `\n\n... [truncated: ${dropped} more bytes; tool limit ${limitBytes} bytes] ...\n`,
    truncated: true,
    limitBytes,
    actualBytes: buf.length,
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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdoutBytes >= MAX_COMMAND_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_COMMAND_OUTPUT_BYTES - stdoutBytes;
      if (chunk.length > room) {
        stdoutChunks.push(chunk.slice(0, room));
        stdoutBytes = MAX_COMMAND_OUTPUT_BYTES;
        truncated = true;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderrBytes >= MAX_COMMAND_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_COMMAND_OUTPUT_BYTES - stderrBytes;
      if (chunk.length > room) {
        stderrChunks.push(chunk.slice(0, room));
        stderrBytes = MAX_COMMAND_OUTPUT_BYTES;
        truncated = true;
        return;
      }
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    });
    child.on("error", reject);
    child.on("close", (exitCode) =>
      resolveCommand({
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode,
        truncated,
        limitBytes: MAX_COMMAND_OUTPUT_BYTES,
      }),
    );
  });
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

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

function mapPermissionTools(value: unknown): string[] {
  const tools = asStringArray(value);
  if (tools.includes("*")) return ["read", "ls", "find", "grep", "bash", "write", "edit"];
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
  return [...out];
}

async function startSession(message: RequestMessage): Promise<void> {
  const cwd = asString(message.cwd) ?? process.cwd();
  const agentDir = asString(message.agentDir) ?? getAgentDir();
  const sessionDir = asString(message.sessionDir);
  const requestedSessionId = asString(message.sessionId);
  const requestedModel = asString(message.model);
  const customInstructions = asString(message.customInstructions);
  const tools = mapPermissionTools(message.allowedTools);
  state.cwd = cwd;
  state.authStorage = AuthStorage.create();
  state.modelRegistry = ModelRegistry.create(state.authStorage);

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPromptOverride: (basePrompt: string[]) => [
      ...basePrompt,
      ...(customInstructions ? [customInstructions] : []),
      "You are running inside Claudette using the Pi SDK harness. Use the available tools normally; Claudette will ask the user for approval before mutating commands or file changes.",
    ],
  });
  await resourceLoader.reload();

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
  const manager = sessionDir
    ? SessionManager.create(cwd, sessionDir)
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
    case "agent_start":
    case "turn_start":
      send({ type: "turn_start" });
      break;
    case "message_update": {
      const update = event.assistantMessageEvent as { type?: string; delta?: string; text?: string };
      const delta = update.delta ?? update.text ?? "";
      if (!delta) break;
      send({
        type:
          update.type === "thinking_delta" || update.type === "reasoning_delta"
            ? "thinking_delta"
            : "assistant_delta",
        delta,
      });
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
    case "turn_end":
      send({
        type: "turn_end",
        error: "errorMessage" in event ? event.errorMessage : undefined,
      });
      break;
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
      send({ type: "initialized", version: "0.74.0" });
      respond(message.id, message.type, true);
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
