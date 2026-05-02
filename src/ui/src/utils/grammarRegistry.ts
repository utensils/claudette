/**
 * Bootstraps the language-grammar plugin pipeline at app startup.
 *
 * Three highlighting surfaces converge here:
 *   1. Chat code blocks — Shiki worker via [[registerGrammar]] in
 *      `utils/highlight.ts`. We route through that module's exported
 *      function rather than spawning a second worker — Web Workers
 *      don't share Shiki state, so a separate worker would never see
 *      the registrations and chat would render plugin languages as
 *      plain text.
 *   2. Diff viewer — same Shiki worker (after the migration off
 *      highlight.js), so registering once covers it too.
 *   3. File editor (Monaco) — main-thread Shiki via
 *      `@shikijs/monaco`. Bound on first Monaco mount via
 *      [[applyGrammarsToMonaco]].
 *
 * Before handing each grammar to Shiki/Monaco, we normalize its
 * `name` and `scopeName` from the plugin manifest. VS Code-style
 * `.tmLanguage.json` files don't always carry a top-level `name`
 * matching the language id we want it registered under, and Shiki's
 * `loadLanguage` keys grammars by `name`. Forcing both fields from
 * the manifest guarantees `monaco.languages.register({ id })` and
 * `getCachedHighlight(code, id)` resolve to the loaded grammar
 * regardless of what the upstream JSON happens to declare.
 *
 * Per-grammar errors are isolated — a single malformed grammar must
 * not break the others.
 *
 * Toggling a grammar plugin off/on in Settings currently requires an
 * app restart to take effect (the registry is built once at boot and
 * cached). Hot-reload is a future enhancement.
 */

import {
  listLanguageGrammars,
  readLanguageGrammar,
} from "../services/grammars";
import type { LanguageInfo } from "../types/grammars";
import { getMainShikiHighlighter } from "./mainShiki";
import {
  registerGrammar as registerGrammarOnWorker,
  __testing as highlightTesting,
} from "./highlight";

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

/**
 * Coerce the parsed grammar JSON to the shape Shiki expects, with the
 * manifest's language id and scope name as the canonical identifiers.
 * Shiki's `loadLanguage` keys grammars by `name` — without this, a
 * grammar JSON missing `name` (or carrying a different one) registers
 * under the wrong key and Monaco/`languageForFile` lookups silently
 * fall back to plaintext.
 */
function normalizeGrammar(
  language: string,
  scopeName: string,
  raw: unknown,
): unknown {
  const base = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { ...base, name: language, scopeName };
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
        const raw = JSON.parse(json) as unknown;
        const grammar = normalizeGrammar(info.language, info.scope_name, raw);
        // Hand the normalized grammar to the same worker that serves
        // chat + diff highlighting (`utils/highlight.ts`). Shiki state
        // is per-worker, so this MUST be the same worker — a separate
        // instance would leave plugin languages rendering as plain
        // text in chat. Fire-and-forget; the worker awaits its own
        // `loadLanguage`, so a follow-up highlight sees it ready.
        registerGrammarOnWorker(info.language, grammar);
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
  //
  // shikiToMonaco also wraps `monaco.editor.setTheme` to drive a
  // matching Shiki theme on every theme switch (and auto-calls
  // `setTheme(themeIds[0])` to initialize). We undo both:
  //
  // 1. Restore the original `setTheme`. Our app's custom Monaco theme
  //    "claudette" is defined locally in `monacoTheme.ts` and is NOT
  //    a Shiki theme — leaving the wrapper in place would crash
  //    inside `highlighter.setTheme("claudette")` when MonacoEditor's
  //    `beforeMount` calls it. The per-language tokens providers
  //    shikiToMonaco installed remain bound and continue to drive
  //    syntax colors regardless.
  // 2. Re-apply `applyMonacoTheme` after shikiToMonaco's auto-call
  //    flipped the active theme to themeIds[0] (e.g. github-light).
  //    Imported lazily here to avoid a static cycle between
  //    grammarRegistry and the file-viewer module.
  try {
    const { shikiToMonaco } = await import("@shikijs/monaco");
    const highlighter = await getMainShikiHighlighter();
    // Capture the unbound method reference. Restoring later as a
    // property assignment preserves the natural `this = monaco.editor`
    // binding any caller gets via `monaco.editor.setTheme(...)`.
    const originalSetTheme = monaco.editor.setTheme;
    shikiToMonaco(highlighter, monaco);
    monaco.editor.setTheme = originalSetTheme;
    const { applyMonacoTheme } = await import(
      "../components/file-viewer/monacoTheme"
    );
    applyMonacoTheme(monaco);
  } catch (e) {
    console.warn("[grammars] Failed to bind Shiki tokenization to Monaco:", e);
  }

  // Race fix: any editor model that was created before the
  // registration completed has `getLanguageId() === "plaintext"`
  // because at the moment Monaco resolved the URI, the plugin
  // languages hadn't been registered yet. Walk the open models and
  // re-set the language for any whose URI now matches one of our
  // newly-registered languages — Monaco re-tokenizes synchronously
  // and Shiki's just-bound provider supplies colors.
  reevaluateOpenModelLanguages(monaco);
}

function reevaluateOpenModelLanguages(
  monaco: typeof import("monaco-editor"),
): void {
  // Build a quick extension/filename → language-id index from the
  // registered plugin languages so we can match without re-walking
  // the registry per model.
  const extToLang = new Map<string, string>();
  const fileToLang = new Map<string, string>();
  for (const lang of state.languages) {
    for (const ext of lang.extensions) {
      extToLang.set(ext.toLowerCase(), lang.id);
    }
    for (const fn of lang.filenames) {
      fileToLang.set(fn.toLowerCase(), lang.id);
    }
  }
  if (extToLang.size === 0 && fileToLang.size === 0) return;

  for (const model of monaco.editor.getModels()) {
    if (model.getLanguageId() !== "plaintext") continue;
    const uriPath = model.uri.path; // already normalized; like "/foo/bar/file.nix"
    const base = uriPath.slice(uriPath.lastIndexOf("/") + 1).toLowerCase();
    let nextLang = fileToLang.get(base);
    if (!nextLang) {
      const dotIdx = base.lastIndexOf(".");
      if (dotIdx >= 0) nextLang = extToLang.get(base.slice(dotIdx));
    }
    if (nextLang) {
      monaco.editor.setModelLanguage(model, nextLang);
    }
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
    // Also drop the highlight-worker singleton — tests assert on the
    // FakeWorker instance count, so leaking the worker between specs
    // would surface as cross-test contamination.
    highlightTesting.reset();
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
