#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const distDir = resolve(__dirname, "../dist");
const timeoutMs = 10_000;

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

async function serveFile(req, res) {
  const requestedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
  const rawPath = decodeURIComponent(requestedUrl.pathname);
  const relativePath = rawPath === "/" ? "index.html" : rawPath.replace(/^\/+/, "");
  const candidate = normalize(join(distDir, relativePath));

  if (candidate !== distDir && !candidate.startsWith(`${distDir}${sep}`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(candidate);
    res.writeHead(200, {
      "content-type": contentTypes.get(extname(candidate)) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(distDir, "index.html"));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500);
      res.end(`Could not read built bundle: ${err}`);
    }
  }
}

async function listen(server) {
  return await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen(server.address());
    });
  });
}

const server = createServer((req, res) => {
  void serveFile(req, res);
});

let browser;
try {
  const address = await listen(server);
  const url = `http://${address.address}:${address.port}/`;

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const failures = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/\b(TypeError|ReferenceError)\b/.test(text)) failures.push(`console: ${text}`);
  });
  page.on("pageerror", (error) => {
    failures.push(`pageerror: ${error.stack || error.message}`);
  });

  await page.addInitScript(() => {
    let nextCallbackId = 1;
    const callbacks = new Map();
    window.__CLAUDETTE_SMOKE_UNKNOWN_INVOKES__ = [];
    window.__TAURI_INTERNALS__ = {
      invoke: async (command) => window.__CLAUDETTE_SMOKE_INVOKE__(command),
      transformCallback: (callback, once = false) => {
        const id = nextCallbackId++;
        callbacks.set(id, { callback, once });
        return id;
      },
      unregisterCallback: (id) => {
        callbacks.delete(id);
      },
      convertFileSrc: (path) => path,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
    };
    window.__CLAUDETTE_SMOKE_INVOKE__ = async (command) => {
      switch (command) {
        case "load_initial_data":
          return {
            repositories: [],
            workspaces: [],
            worktree_base_dir: "/tmp/claudette-smoke/workspaces",
            default_branches: {},
            last_messages: [],
            scm_cache: [],
            manual_workspace_order_repo_ids: [],
          };
        case "get_diagnostics_settings":
          return { log_level: null, rust_log_override: null, frontend_verbosity: null };
        case "plugin:app|version":
          return "0.0.0-smoke";
        case "get_host_env_flags":
          return { alternative_backends_compiled: false, disable_1m_context: false };
        case "list_agent_backends":
          return { backends: [], default_backend_id: "anthropic" };
        case "list_remote_connections":
        case "list_discovered_servers":
        case "detect_installed_apps":
        case "list_system_fonts":
        case "list_app_settings_with_prefix":
        case "list_user_themes":
          return [];
        case "get_local_server_status":
          return { running: false, connection_string: null };
        case "get_app_setting":
        case "boot_ok":
        case "plugin:event|unlisten":
        case "log_from_frontend":
          return null;
        case "plugin:event|listen":
          return 1;
        default:
          // Record but don't throw — bubbling an exception here causes
          // a chain of unhandled-rejection console errors that mask the
          // first useful diagnostic. We collect the unknown command and
          // let the Node side decide whether to fail the run after the
          // boot completes.
          window.__CLAUDETTE_SMOKE_UNKNOWN_INVOKES__.push(command);
          return null;
      }
    };
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForFunction(
    () =>
      Boolean(window.__claudetteHijackBlocked) ||
      (document.getElementById("root")?.childElementCount ?? 0) > 0,
    null,
    { timeout: timeoutMs },
  );

  if (failures.length > 0) {
    throw new Error(`Bundle boot emitted fatal errors:\n${failures.join("\n")}`);
  }

  // Surface unmocked Tauri commands so new boot-time IPC doesn't slip
  // past the smoke. This is a warning today (env-gated to fail-loud)
  // rather than a hard failure — the smoke is meant to catch *boot*
  // breakage; an unmocked but optional command shouldn't block PRs
  // unless we explicitly want it to.
  const unknown = await page.evaluate(() => window.__CLAUDETTE_SMOKE_UNKNOWN_INVOKES__ || []);
  const dedup = Array.from(new Set(unknown));
  if (dedup.length > 0) {
    const msg = `Smoke saw unmocked Tauri invocations: ${dedup.join(", ")}`;
    if (process.env.CLAUDETTE_SMOKE_STRICT === "1") {
      throw new Error(msg);
    }
    console.warn(`warn: ${msg}`);
  }

  console.log(`Built bundle boot smoke passed at ${url}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
