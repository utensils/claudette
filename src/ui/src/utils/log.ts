// Frontend → backend structured-log bridge.
//
// Everything written here forwards to the Rust `tracing` registry via
// the `log_from_frontend` Tauri command, where it's emitted under the
// `claudette::frontend` target so it lands in the same daily log file
// as backend events. That's the whole point: when a user files a bug
// report, one file captures both halves of the app.
//
// Boot sequence (from `main.tsx`):
//   1. The bridge defaults to `errors`-only verbosity. That keeps the
//      log clean unless the user opts into more.
//   2. Once the diagnostics settings load, `setFrontendLogVerbosity`
//      reconfigures the console mirror at runtime — no rebind, just a
//      shared mutable level the global handlers read.
//   3. `installFrontendLogBridge` is idempotent. Calling it twice is a
//      no-op (matters for hot-reload during dev).
//
// Note on `console.*` mirroring: we DO replace `console.error` /
// `.warn` / `.info` / `.log` (browsers don't expose them as events
// otherwise) but our patch always invokes the original method first
// inside a try/catch, then fans out to the Rust forwarder. That
// preserves the exact devtools output — including React's
// StrictMode `console.error` calls, which look at the original
// signature. The console patches install once on the first
// `installFrontendLogBridge` call and respect a mutable verbosity
// gate; changing the user's verbosity in Settings rebinds the gate
// without re-patching.

import { invoke } from "@tauri-apps/api/core";

/// Wire-format mirrors the Rust `FrontendLogLevel` enum (lowercase).
type FrontendLogLevel = "trace" | "debug" | "info" | "warn" | "error";

/// Wire-format mirrors the Rust setting value. Persisted in
/// `app_settings["diagnostics.frontend_verbosity"]`.
export type FrontendLogVerbosity = "errors" | "warnings" | "all";

interface FrontendLogPayload {
  level: FrontendLogLevel;
  /// Sub-domain inside `claudette::frontend`. Free-form. The Rust side
  /// stamps this into a `frontend_target` structured field — every
  /// event still lands under one filterable target.
  frontend_target?: string;
  message: string;
  fields?: Record<string, unknown> | null;
  source?: string;
  stack?: string;
}

// Single source of truth for the live verbosity. Closures captured
// inside event handlers read this on every fire so a Settings-change
// takes effect without rebinding listeners.
let currentVerbosity: FrontendLogVerbosity = "errors";

// Two install phases:
//   - Phase 1 (auto on module load below): `window.error` and
//     `unhandledrejection` listeners. ES module imports evaluate
//     BEFORE any top-level statement in `main.tsx`, so an
//     `installFrontendLogBridge()` call there can't catch a crash
//     thrown by `./i18n` / `App` / grammar / Shiki bootstrap. We
//     fire these listeners as a side effect of importing `log.ts`
//     so just `import "./utils/log"` first in `main.tsx` arms them
//     before the rest of the import graph resolves.
//   - Phase 2 (explicit `installFrontendLogBridge()` call): console
//     mirroring, keyed by user verbosity. Console patches are
//     deferred until the user has loaded so we don't intercept
//     React StrictMode warnings firing inside one of the imports
//     above.
let earlyListenersInstalled = false;
let consolePatched = false;

/// Forward a log line to the Rust subscriber. Failures are swallowed —
/// if the Tauri bridge is gone (e.g. during teardown), we cannot
/// recover by logging "log forward failed", so we don't try.
async function forward(payload: FrontendLogPayload): Promise<void> {
  try {
    await invoke("log_from_frontend", { payload });
  } catch {
    // Intentionally silent — see comment above. Reaching this branch
    // means the Tauri bridge tore down before the listener fired,
    // which is a normal teardown race in dev hot-reload.
  }
}

/// Convenience wrappers. Call sites prefer these over manually
/// constructing a payload — they keep the signature consistent and
/// give us one chokepoint to add behavior later (e.g. local storage
/// of recent events for an in-app debug viewer).
export const log = {
  trace(target: string, message: string, fields?: Record<string, unknown>): void {
    void forward({ level: "trace", frontend_target: target, message, fields });
  },
  debug(target: string, message: string, fields?: Record<string, unknown>): void {
    void forward({ level: "debug", frontend_target: target, message, fields });
  },
  info(target: string, message: string, fields?: Record<string, unknown>): void {
    void forward({ level: "info", frontend_target: target, message, fields });
  },
  warn(target: string, message: string, fields?: Record<string, unknown>): void {
    void forward({ level: "warn", frontend_target: target, message, fields });
  },
  error(
    target: string,
    message: string,
    fields?: Record<string, unknown>,
    stack?: string,
  ): void {
    void forward({
      level: "error",
      frontend_target: target,
      message,
      fields,
      stack,
    });
  },
} as const;

/// Format whatever the user passed to `console.warn`/`console.error`
/// into a single message string. Browsers stringify themselves, but
/// they do it lazily; here we collapse to a stable string up front so
/// the Rust side gets one message field instead of an unbounded
/// `arguments` array. Errors keep their stack — that's the data
/// postmortems actually want.
function formatConsoleArgs(args: unknown[]): { message: string; stack?: string } {
  if (args.length === 0) {
    return { message: "" };
  }
  let stack: string | undefined;
  const parts = args.map((arg) => {
    if (arg instanceof Error) {
      // First Error wins for the stack field; later ones get
      // serialized into the message so they're not lost.
      if (!stack && typeof arg.stack === "string") {
        stack = arg.stack;
      }
      return arg.message;
    }
    if (typeof arg === "string") return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
  return { message: parts.join(" "), stack };
}

/// Install `window.error` + `unhandledrejection` listeners. Called
/// automatically below as a module-load side effect so it runs
/// before any other module in `main.tsx`'s import graph evaluates —
/// crashes inside i18n / grammar / Shiki / App import-time setup
/// land in the daily log instead of the devtools console.
function installEarlyListeners(): void {
  if (earlyListenersInstalled) return;
  earlyListenersInstalled = true;

  // Window error events — uncaught synchronous throws.
  window.addEventListener("error", (event) => {
    // Some browsers fire `error` for resource-load failures (e.g.
    // <img src="...">). `event.error` is null in those cases; fall
    // back to the message + filename so we still log them, just at
    // warn instead of error.
    if (!event.error && !event.message) return;
    const message = event.message || "uncaught error";
    void forward({
      level: event.error ? "error" : "warn",
      frontend_target: event.error ? "unhandled-error" : "resource-load-error",
      message,
      source: event.filename || undefined,
      stack: event.error?.stack ?? undefined,
      fields: {
        line: event.lineno,
        column: event.colno,
      },
    });
  });

  // Unhandled promise rejections — uncaught async throws.
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    let message: string;
    let stack: string | undefined;
    let fields: Record<string, unknown> | undefined;
    if (reason instanceof Error) {
      message = reason.message;
      stack = reason.stack;
    } else if (typeof reason === "string") {
      message = reason;
    } else {
      try {
        message = JSON.stringify(reason);
      } catch {
        message = String(reason);
      }
      fields = { reason_type: typeof reason };
    }
    void forward({
      level: "error",
      frontend_target: "unhandled-rejection",
      message,
      stack,
      fields,
    });
  });
}

/// Wire console mirroring per verbosity. Idempotent: console patches
/// install once; later calls just rebind verbosity.
///
/// Sources mirrored, all under `claudette::frontend`:
/// - `console.error` (always)               → `console-error`
/// - `console.warn`  (verbosity ≥ warnings) → `console-warn`
/// - `console.log/info` (verbosity = all)   → `console-log` / `console-info`
///
/// `ErrorBoundary.componentDidCatch` calls `log.error` directly — it
/// already runs after a React render error, so wiring it here would
/// be a duplicate.
export function installFrontendLogBridge(initial: FrontendLogVerbosity = "errors"): void {
  // Defensive: if some caller manages to invoke this before module
  // load fully runs (vitest hot-reload edge case), the early
  // listeners still need to exist.
  installEarlyListeners();
  currentVerbosity = initial;
  if (consolePatched) return;
  consolePatched = true;

  // Console mirrors. We patch the real console methods (rather than
  // adding listeners — there are no events) but always call the
  // original first so devtools and React's StrictMode warnings still
  // see the input verbatim. Patches are guarded by `currentVerbosity`
  // so changing the setting doesn't require reinstalling.
  patchConsoleMethod("error", "console-error", "error", () => true);
  patchConsoleMethod("warn", "console-warn", "warn", () =>
    currentVerbosity === "warnings" || currentVerbosity === "all",
  );
  patchConsoleMethod("info", "console-info", "info", () => currentVerbosity === "all");
  patchConsoleMethod("log", "console-log", "info", () => currentVerbosity === "all");
}

// Side-effect on import: arm the listeners as soon as this module
// loads. `main.tsx` imports `./utils/log` before its other modules
// for exactly this reason — see the comment block at the top of
// this file.
installEarlyListeners();

/// Update the live verbosity. Used by the Diagnostics settings panel
/// after `set_frontend_verbosity` has persisted the change.
export function setFrontendLogVerbosity(level: FrontendLogVerbosity): void {
  currentVerbosity = level;
}

/// Wrap a `console.<method>` so calls always dispatch to the original
/// AND, when `enabled()` returns true, also forward to the Rust log.
/// We keep references to the originals via closure capture so a later
/// patch (e.g. dev tooling) can stack on top without breaking us.
/// Narrow indexable view of the four console methods we mirror. Lets
/// us read the original method off `console` and write a wrapper back
/// without an `any` cast — the lib.dom `Console` type uses
/// overload-heavy signatures that don't survive `Console[K]` access,
/// but the only contract we need from these methods is "consumes
/// arbitrary args, returns nothing".
type ConsoleMethodName = "error" | "warn" | "info" | "log";
type MirroredConsole = Record<ConsoleMethodName, (...args: unknown[]) => void>;

function patchConsoleMethod(
  method: ConsoleMethodName,
  frontendTarget: string,
  level: FrontendLogLevel,
  enabled: () => boolean,
): void {
  // Cast through `unknown` (eslint allows it without a disable, and
  // the runtime shape of these four methods is exactly the wrapper
  // contract above).
  const target = console as unknown as MirroredConsole;
  const original = target[method];
  target[method] = (...args: unknown[]) => {
    try {
      original.apply(console, args);
    } catch {
      // If the original throws, still attempt to forward — losing both
      // sides of the log is worse than losing the devtools side.
    }
    if (!enabled()) return;
    const { message, stack } = formatConsoleArgs(args);
    if (!message && !stack) return;
    void forward({
      level,
      frontend_target: frontendTarget,
      message,
      stack,
    });
  };
}
