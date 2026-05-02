/**
 * Bootstraps the language-grammar plugin pipeline at app startup.
 *
 * Three highlighting surfaces converge here:
 *   1. Chat code blocks — Shiki worker (`workers/highlight.worker.ts`).
 *      The worker receives a `register-grammar` message per grammar.
 *   2. Diff viewer — same Shiki worker (after the migration off
 *      highlight.js), so registering once covers it too.
 *   3. File editor (Monaco) — main-thread Shiki via
 *      `@shikijs/monaco`. Bound on first Monaco mount via
 *      [[applyGrammarsToMonaco]].
 *
 * The bootstrap fetches grammar metadata from the backend, fetches
 * each grammar's TextMate JSON lazily, parses it once, and dispatches
 * to all three surfaces. Per-grammar errors are isolated — a single
 * malformed grammar must not break the others.
 *
 * Toggling a grammar plugin off/on in Settings currently requires an
 * app restart to take effect (the registry is built once at boot and
 * cached). Hot-reload is a future enhancement.
 */

import HighlightWorker from "../workers/highlight.worker?worker";
import {
  listLanguageGrammars,
  readLanguageGrammar,
} from "../services/grammars";
import type { LanguageInfo } from "../types/grammars";
import { getMainShikiHighlighter } from "./mainShiki";

interface LoadedGrammar {
  language: string;
  scopeName: string;
  /** Parsed TextMate grammar object, ready for `loadLanguage`. */
  grammar: unknown;
}

interface RegistryState {
  bootstrapped: boolean;
  bootstrapPromise: Promise<void> | null;
  languages: LanguageInfo[];
  grammars: LoadedGrammar[];
  monacoApplied: boolean;
}

const state: RegistryState = {
  bootstrapped: false,
  bootstrapPromise: null,
  languages: [],
  grammars: [],
  monacoApplied: false,
};

let workerSingleton: Worker | null = null;

/**
 * Lazy-create a dedicated worker for grammar registration. We could
 * reuse the highlight worker spawned by `utils/highlight.ts`, but
 * that module manages its own lifecycle (HMR disposal, error
 * recovery) and exposing its private worker handle would couple the
 * two modules unnecessarily. A second worker for fire-and-forget
 * grammar registration is cheap and isolates the concerns.
 */
function getWorker(): Worker {
  if (!workerSingleton) {
    workerSingleton = new HighlightWorker();
  }
  return workerSingleton;
}

/**
 * Run once at app startup. Idempotent — concurrent callers share the
 * same in-flight promise so we never duplicate the network/registry
 * calls. Safe to call before React renders; safe to call repeatedly.
 */
export function bootstrapGrammarRegistry(): Promise<void> {
  if (state.bootstrapped) return Promise.resolve();
  if (state.bootstrapPromise) return state.bootstrapPromise;
  state.bootstrapPromise = bootstrapInner().finally(() => {
    state.bootstrapped = true;
  });
  return state.bootstrapPromise;
}

async function bootstrapInner(): Promise<void> {
  let registry;
  try {
    registry = await listLanguageGrammars();
  } catch (e) {
    console.warn("[grammars] Failed to list language grammars:", e);
    return;
  }

  state.languages = registry.languages;

  // Load each grammar in parallel; errors are isolated per-grammar.
  // Promise.allSettled lets one bad grammar coexist with good ones.
  await Promise.allSettled(
    registry.grammars.map(async (info) => {
      try {
        const json = await readLanguageGrammar(info.plugin_name, info.path);
        const grammar = JSON.parse(json) as unknown;
        // Fire-and-forget into the worker. The worker's
        // `register-grammar` handler awaits its own loadLanguage,
        // so subsequent highlight requests for this lang see it
        // loaded. No response needed.
        getWorker().postMessage({
          type: "register-grammar",
          lang: info.language,
          grammar,
        });
        // Eagerly load into the main-thread Shiki so Monaco
        // tokenization is ready the moment the editor mounts.
        try {
          const hl = await getMainShikiHighlighter();
          await hl.loadLanguage(grammar as never);
        } catch (e) {
          console.warn(
            `[grammars] Main-thread Shiki rejected grammar "${info.language}":`,
            e,
          );
        }
        state.grammars.push({
          language: info.language,
          scopeName: info.scope_name,
          grammar,
        });
      } catch (e) {
        console.warn(
          `[grammars] Failed to load grammar ${info.plugin_name}/${info.path}:`,
          e,
        );
      }
    }),
  );
}

/**
 * Bind plugin-contributed languages and grammars to a Monaco
 * instance. Called from `monacoSetup.ts` once Monaco itself has been
 * loaded (Monaco is lazy-imported only when the file editor first
 * mounts). Idempotent: subsequent mounts skip the work.
 *
 * Awaits `bootstrapGrammarRegistry` first so the registry data is
 * ready even if `monacoSetup` runs before main.tsx has finished its
 * own bootstrap (race-free on app start).
 */
export async function applyGrammarsToMonaco(
  monaco: typeof import("monaco-editor"),
): Promise<void> {
  if (state.monacoApplied) return;
  await bootstrapGrammarRegistry();
  state.monacoApplied = true;

  if (state.languages.length === 0) return;

  // Register every language id with Monaco so file-extension and
  // alias resolution work in `MonacoEditor`'s `path={filename}`
  // detection. This must happen BEFORE shikiToMonaco binds tokens.
  for (const lang of state.languages) {
    monaco.languages.register({
      id: lang.id,
      extensions: lang.extensions,
      aliases: lang.aliases,
      filenames: lang.filenames,
      ...(lang.first_line_pattern
        ? { firstLine: lang.first_line_pattern }
        : {}),
    });
  }

  if (state.grammars.length === 0) return;

  // Bind the main-thread Shiki to Monaco — `shikiToMonaco` installs
  // a tokenization provider for every language Monaco knows about
  // that's also loaded in the highlighter. Re-runs are safe; later
  // `loadLanguage` calls on the highlighter take effect through the
  // bound provider without rebinding.
  try {
    const { shikiToMonaco } = await import("@shikijs/monaco");
    const highlighter = await getMainShikiHighlighter();
    shikiToMonaco(highlighter, monaco);
  } catch (e) {
    console.warn("[grammars] Failed to bind Shiki tokenization to Monaco:", e);
  }
}

/**
 * Snapshot of language metadata contributed by enabled
 * `language-grammar` plugins. Returns the in-memory state — call
 * after `bootstrapGrammarRegistry` resolves (or `await` it first) to
 * avoid getting an empty list during boot.
 */
export function getRegisteredPluginLanguages(): readonly LanguageInfo[] {
  return state.languages;
}

/** Test-only — reset the singleton state. Used by vitest specs. */
export const __testing = {
  reset(): void {
    state.bootstrapped = false;
    state.bootstrapPromise = null;
    state.languages = [];
    state.grammars = [];
    state.monacoApplied = false;
    if (workerSingleton) {
      workerSingleton.terminate();
      workerSingleton = null;
    }
  },
  getState(): Readonly<RegistryState> {
    return state;
  },
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    __testing.reset();
  });
}
