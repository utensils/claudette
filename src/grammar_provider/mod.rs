//! Grammar provider — backend dispatcher for the `language-grammar`
//! plugin kind. Surfaces TextMate grammars contributed by user and
//! bundled plugins to the frontend so Shiki (chat + diffs) and
//! Monaco (file editor) can register them.
//!
//! Unlike `scm` and `env-provider`, this dispatcher never invokes the
//! Lua VM. Grammar plugins are purely declarative: the manifest names
//! the grammar files and this module reads them straight off disk
//! (with path-traversal protection and a size cap).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::plugin_runtime::PluginRegistry;
use crate::plugin_runtime::manifest::PluginKind;

/// Hard cap on the size of a grammar JSON we will read into memory.
/// TextMate grammars are typically under 500 KB; the 4 MB ceiling is
/// generous for unusually large grammars (TypeScript's is the largest
/// in common use at ~600 KB) while still bounding allocations against
/// a malformed or malicious plugin.
const MAX_GRAMMAR_BYTES: u64 = 4 * 1024 * 1024;

/// Metadata about a single grammar contribution. Frontend consumes
/// this to know which Shiki worker / Monaco language to register the
/// grammar under, then issues a follow-up `read_language_grammar`
/// call to fetch the actual JSON body.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GrammarInfo {
    /// Plugin that contributed this grammar — used to namespace the
    /// later `read_language_grammar` call.
    pub plugin_name: String,
    /// Language id this grammar binds to (matches a `LanguageInfo`
    /// in the same plugin's `languages` slot).
    pub language: String,
    /// Top-level scope name, e.g. `"source.nix"`. Required because
    /// theme rules and injection grammars key off scope names rather
    /// than language ids.
    pub scope_name: String,
    /// Plugin-relative path to the grammar JSON. Frontend treats this
    /// as an opaque token to pass back to `read_language_grammar`.
    pub path: String,
}

/// Metadata about a language declared by a plugin. Mirrors VS Code's
/// `contributes.languages` shape so users can copy entries directly
/// from existing extensions.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LanguageInfo {
    pub plugin_name: String,
    pub id: String,
    pub extensions: Vec<String>,
    pub filenames: Vec<String>,
    pub aliases: Vec<String>,
    pub first_line_pattern: Option<String>,
}

/// Bundle of contributions returned to the frontend in a single
/// command call. Languages and grammars are listed separately because
/// a language can be declared without a grammar (e.g. metadata-only
/// shimming) and a grammar always references a language id.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GrammarRegistry {
    pub languages: Vec<LanguageInfo>,
    pub grammars: Vec<GrammarInfo>,
}

/// Errors that the grammar provider exposes to Tauri commands and the
/// frontend. Strings are user-facing; keep them brief.
#[derive(Debug, Clone, PartialEq)]
pub enum GrammarError {
    PluginNotFound(String),
    NotGrammarKind(String),
    PluginDisabled(String),
    /// The requested path isn't listed in the plugin's `grammars` manifest
    /// slot. Distinct from `PathOutsidePlugin` so callers (and humans
    /// reading logs) can tell an undeclared internal path from a
    /// directory-escape attempt.
    PathNotDeclared {
        plugin: String,
        path: String,
    },
    PathOutsidePlugin {
        plugin: String,
        path: String,
    },
    GrammarTooLarge {
        plugin: String,
        path: String,
        size: u64,
    },
    ReadFailed {
        plugin: String,
        path: String,
        message: String,
    },
}

impl std::fmt::Display for GrammarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PluginNotFound(name) => write!(f, "Plugin '{name}' not found"),
            Self::NotGrammarKind(name) => {
                write!(f, "Plugin '{name}' is not a language-grammar plugin")
            }
            Self::PluginDisabled(name) => write!(f, "Plugin '{name}' is disabled"),
            Self::PathNotDeclared { plugin, path } => write!(
                f,
                "Grammar path '{path}' is not declared in plugin '{plugin}' manifest"
            ),
            Self::PathOutsidePlugin { plugin, path } => write!(
                f,
                "Grammar path '{path}' for plugin '{plugin}' escapes the plugin directory"
            ),
            Self::GrammarTooLarge { plugin, path, size } => write!(
                f,
                "Grammar '{path}' in plugin '{plugin}' is {size} bytes — exceeds the {} MB cap",
                MAX_GRAMMAR_BYTES / (1024 * 1024)
            ),
            Self::ReadFailed {
                plugin,
                path,
                message,
            } => write!(
                f,
                "Failed to read grammar '{path}' from plugin '{plugin}': {message}"
            ),
        }
    }
}

impl std::error::Error for GrammarError {}

impl serde::Serialize for GrammarError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Collect language and grammar metadata from every enabled
/// `language-grammar` plugin in the registry. Disabled plugins are
/// filtered out silently — toggling them off in the Plugins settings
/// is the user's signal that they don't want the grammar applied.
pub fn list_registry(registry: &PluginRegistry) -> GrammarRegistry {
    let mut languages = Vec::new();
    let mut grammars = Vec::new();

    for (name, plugin) in &registry.plugins {
        if plugin.manifest.kind != PluginKind::LanguageGrammar {
            continue;
        }
        if registry.is_disabled(name) {
            continue;
        }
        for lang in &plugin.manifest.languages {
            languages.push(LanguageInfo {
                plugin_name: name.clone(),
                id: lang.id.clone(),
                extensions: lang.extensions.clone(),
                filenames: lang.filenames.clone(),
                aliases: lang.aliases.clone(),
                first_line_pattern: lang.first_line_pattern.clone(),
            });
        }
        for grammar in &plugin.manifest.grammars {
            grammars.push(GrammarInfo {
                plugin_name: name.clone(),
                language: grammar.language.clone(),
                scope_name: grammar.scope_name.clone(),
                path: grammar.path.clone(),
            });
        }
    }

    GrammarRegistry {
        languages,
        grammars,
    }
}

/// Read a grammar's bytes from disk. The `relative_path` is the same
/// token returned by [`list_registry`] — frontend passes it back to
/// us verbatim. The plugin must:
///
/// - exist in the registry
/// - be of `language-grammar` kind (we won't surface arbitrary files
///   from operation-driven plugins)
/// - be enabled — disabled plugins are filtered out of `list_registry`,
///   and reading their bytes anyway would let a stale frontend
///   reference resurrect a grammar the user explicitly turned off
/// - declare the requested path in its `grammars` manifest slot
///   (defends against a frontend asking for arbitrary files inside
///   the plugin directory)
///
/// The resolved canonical path must descend from the plugin's
/// canonical directory so symlinks pointing outside (or `..`
/// components) are rejected. Mirrors the
/// `resolve_inside_workspace` pattern in
/// `src/plugin_runtime/host_api.rs:218` rooted at `plugin.dir`.
pub fn read_grammar(
    registry: &PluginRegistry,
    plugin_name: &str,
    relative_path: &str,
) -> Result<String, GrammarError> {
    let plugin = registry
        .plugins
        .get(plugin_name)
        .ok_or_else(|| GrammarError::PluginNotFound(plugin_name.to_string()))?;

    if plugin.manifest.kind != PluginKind::LanguageGrammar {
        return Err(GrammarError::NotGrammarKind(plugin_name.to_string()));
    }

    if registry.is_disabled(plugin_name) {
        return Err(GrammarError::PluginDisabled(plugin_name.to_string()));
    }

    // Path must be one the manifest declared. Without this check, a
    // compromised webview could read any file inside the plugin dir.
    let declared = plugin
        .manifest
        .grammars
        .iter()
        .any(|g| g.path == relative_path);
    if !declared {
        return Err(GrammarError::PathNotDeclared {
            plugin: plugin_name.to_string(),
            path: relative_path.to_string(),
        });
    }

    let canonical_root = plugin
        .dir
        .canonicalize()
        .map_err(|e| GrammarError::ReadFailed {
            plugin: plugin_name.to_string(),
            path: relative_path.to_string(),
            message: format!("plugin directory missing: {e}"),
        })?;

    let resolved = resolve_inside(&canonical_root, relative_path).ok_or_else(|| {
        GrammarError::PathOutsidePlugin {
            plugin: plugin_name.to_string(),
            path: relative_path.to_string(),
        }
    })?;

    let metadata = std::fs::metadata(&resolved).map_err(|e| GrammarError::ReadFailed {
        plugin: plugin_name.to_string(),
        path: relative_path.to_string(),
        message: e.to_string(),
    })?;
    if metadata.len() > MAX_GRAMMAR_BYTES {
        return Err(GrammarError::GrammarTooLarge {
            plugin: plugin_name.to_string(),
            path: relative_path.to_string(),
            size: metadata.len(),
        });
    }

    std::fs::read_to_string(&resolved).map_err(|e| GrammarError::ReadFailed {
        plugin: plugin_name.to_string(),
        path: relative_path.to_string(),
        message: e.to_string(),
    })
}

/// Resolve `relative` against `root` and return the canonical form if
/// (and only if) it descends from `root`. Mirrors the workspace
/// confinement helper used by `host.read_file`. Returns `None` if:
///
/// - `relative` is absolute (refuse — manifests must use plugin-local
///   paths)
/// - the joined path doesn't exist
/// - canonicalization escapes `root` (symlinks pointing outside,
///   `..` traversal that climbs above)
fn resolve_inside(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.is_empty() {
        return None;
    }
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return None;
    }
    let joined = root.join(candidate);
    let canonical = joined.canonicalize().ok()?;
    if canonical.starts_with(root) {
        Some(canonical)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    use crate::plugin_runtime::LoadedPlugin;
    use crate::plugin_runtime::manifest::{
        GrammarContribution, LanguageContribution, PluginManifest,
    };

    fn write_grammar_plugin(plugin_dir: &Path, manifest: PluginManifest, grammar_body: &str) {
        fs::create_dir_all(plugin_dir.join("grammars")).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            plugin_dir.join("grammars/test.tmLanguage.json"),
            grammar_body,
        )
        .unwrap();
    }

    fn make_grammar_manifest(name: &str) -> PluginManifest {
        PluginManifest {
            name: name.to_string(),
            display_name: name.to_string(),
            version: "1.0.0".to_string(),
            description: "test grammar".to_string(),
            required_clis: vec![],
            remote_patterns: vec![],
            operations: vec![],
            config_schema: HashMap::new(),
            kind: PluginKind::LanguageGrammar,
            settings: vec![],
            languages: vec![LanguageContribution {
                id: "test".to_string(),
                extensions: vec![".test".to_string()],
                filenames: vec![],
                aliases: vec!["Test".to_string()],
                first_line_pattern: None,
            }],
            grammars: vec![GrammarContribution {
                language: "test".to_string(),
                scope_name: "source.test".to_string(),
                path: "grammars/test.tmLanguage.json".to_string(),
            }],
        }
    }

    #[test]
    fn list_registry_returns_languages_and_grammars_for_grammar_plugins() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-test");
        write_grammar_plugin(
            &plugin_dir,
            make_grammar_manifest("lang-test"),
            r#"{"scopeName":"source.test","patterns":[]}"#,
        );

        let registry = PluginRegistry::discover(dir.path());
        let listed = list_registry(&registry);

        assert_eq!(listed.languages.len(), 1);
        assert_eq!(listed.languages[0].id, "test");
        assert_eq!(listed.languages[0].extensions, vec![".test".to_string()]);
        assert_eq!(listed.grammars.len(), 1);
        assert_eq!(listed.grammars[0].language, "test");
        assert_eq!(listed.grammars[0].scope_name, "source.test");
    }

    #[test]
    fn list_registry_skips_non_grammar_kinds() {
        // Fabricate a registry containing one SCM plugin and assert
        // it doesn't leak into the grammar listing.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("scm-thing");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "scm-thing",
                "display_name": "SCM",
                "version": "1.0.0",
                "description": "scm",
                "kind": "scm",
                "operations": ["list_pull_requests"]
            }"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("init.lua"), "return {}").unwrap();

        let registry = PluginRegistry::discover(dir.path());
        let listed = list_registry(&registry);
        assert!(listed.languages.is_empty());
        assert!(listed.grammars.is_empty());
    }

    #[test]
    fn list_registry_skips_disabled_plugins() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-test");
        write_grammar_plugin(
            &plugin_dir,
            make_grammar_manifest("lang-test"),
            r#"{"scopeName":"source.test","patterns":[]}"#,
        );

        let registry = PluginRegistry::discover(dir.path());
        registry.set_disabled("lang-test", true);
        let listed = list_registry(&registry);
        assert!(
            listed.languages.is_empty(),
            "disabled plugin must be filtered out"
        );
        assert!(listed.grammars.is_empty());
    }

    #[test]
    fn read_grammar_returns_file_contents() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-test");
        let body = r#"{"scopeName":"source.test","patterns":[]}"#;
        write_grammar_plugin(&plugin_dir, make_grammar_manifest("lang-test"), body);

        let registry = PluginRegistry::discover(dir.path());
        let result = read_grammar(&registry, "lang-test", "grammars/test.tmLanguage.json").unwrap();
        assert_eq!(result, body);
    }

    #[test]
    fn read_grammar_rejects_path_not_declared_in_manifest() {
        // Even files that exist inside the plugin directory must be
        // refused unless the manifest declared them. Defends against
        // a compromised webview reading arbitrary plugin files. The
        // distinct `PathNotDeclared` variant lets logs/UI distinguish
        // an undeclared internal file from a directory-escape attempt.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-test");
        write_grammar_plugin(
            &plugin_dir,
            make_grammar_manifest("lang-test"),
            r#"{"scopeName":"source.test","patterns":[]}"#,
        );
        // Drop a sibling file that's NOT declared in `grammars`.
        fs::write(plugin_dir.join("plugin.json.bak"), "secret").unwrap();

        let registry = PluginRegistry::discover(dir.path());
        let result = read_grammar(&registry, "lang-test", "plugin.json.bak");
        assert!(matches!(result, Err(GrammarError::PathNotDeclared { .. })));
    }

    #[test]
    fn read_grammar_rejects_dotdot_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-test");
        write_grammar_plugin(
            &plugin_dir,
            make_grammar_manifest("lang-test"),
            r#"{"scopeName":"source.test","patterns":[]}"#,
        );

        let registry = PluginRegistry::discover(dir.path());
        // Manifest doesn't declare this path, so the manifest check
        // catches it before resolution would — surfaces as
        // `PathNotDeclared`, not `PathOutsidePlugin`. That's the
        // layered defense; either rejection is sufficient.
        let result = read_grammar(&registry, "lang-test", "../../../etc/passwd");
        assert!(matches!(result, Err(GrammarError::PathNotDeclared { .. })));
    }

    #[test]
    fn read_grammar_rejects_disabled_plugin() {
        // Disabled plugins are filtered out of `list_registry`; reading
        // their bytes via a stale frontend reference would resurrect
        // a grammar the user explicitly turned off.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-test");
        write_grammar_plugin(
            &plugin_dir,
            make_grammar_manifest("lang-test"),
            r#"{"scopeName":"source.test","patterns":[]}"#,
        );

        let registry = PluginRegistry::discover(dir.path());
        registry.set_disabled("lang-test", true);
        let result = read_grammar(&registry, "lang-test", "grammars/test.tmLanguage.json");
        assert!(matches!(result, Err(GrammarError::PluginDisabled(_))));
    }

    #[test]
    fn read_grammar_rejects_unknown_plugin() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::discover(dir.path());
        let result = read_grammar(&registry, "no-such-plugin", "grammars/x.json");
        assert!(matches!(result, Err(GrammarError::PluginNotFound(_))));
    }

    #[test]
    fn read_grammar_rejects_non_grammar_kind() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("scm-thing");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "scm-thing",
                "display_name": "SCM",
                "version": "1.0.0",
                "description": "scm",
                "kind": "scm",
                "operations": ["list_pull_requests"]
            }"#,
        )
        .unwrap();
        fs::write(plugin_dir.join("init.lua"), "return {}").unwrap();

        let registry = PluginRegistry::discover(dir.path());
        let result = read_grammar(&registry, "scm-thing", "anything.json");
        assert!(matches!(result, Err(GrammarError::NotGrammarKind(_))));
    }

    #[test]
    fn read_grammar_enforces_size_cap() {
        // Construct a registry with a manifest that declares a
        // grammar path pointing at a file larger than the cap. We
        // build the LoadedPlugin directly so the test stays under
        // the size limit on disk by writing the bloated file
        // ourselves only after manifest parsing.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-test");
        write_grammar_plugin(
            &plugin_dir,
            make_grammar_manifest("lang-test"),
            r#"{"scopeName":"source.test"}"#,
        );

        // Overwrite the grammar with content exceeding the cap.
        let mut huge = String::with_capacity((MAX_GRAMMAR_BYTES + 1024) as usize);
        huge.push('"');
        huge.push_str(&"x".repeat((MAX_GRAMMAR_BYTES + 1024) as usize));
        huge.push('"');
        fs::write(plugin_dir.join("grammars/test.tmLanguage.json"), &huge).unwrap();

        let registry = PluginRegistry::discover(dir.path());
        let result = read_grammar(&registry, "lang-test", "grammars/test.tmLanguage.json");
        assert!(matches!(result, Err(GrammarError::GrammarTooLarge { .. })));
    }

    #[test]
    fn read_grammar_rejects_absolute_path_in_manifest() {
        // A manifest that declares an absolute path is malformed;
        // the resolver must reject it even after the manifest check
        // passes.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-bad");
        fs::create_dir_all(&plugin_dir).unwrap();

        let mut manifest = make_grammar_manifest("lang-bad");
        // Absolute paths bypass the resolver intent.
        manifest.grammars[0].path = "/etc/passwd".to_string();
        fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();

        let registry = PluginRegistry::discover(dir.path());
        let result = read_grammar(&registry, "lang-bad", "/etc/passwd");
        assert!(matches!(
            result,
            Err(GrammarError::PathOutsidePlugin { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn read_grammar_rejects_symlink_escaping_plugin_dir() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-test");
        write_grammar_plugin(
            &plugin_dir,
            make_grammar_manifest("lang-test"),
            r#"{"scopeName":"source.test"}"#,
        );

        // Replace the grammar with a symlink pointing outside the
        // plugin tree.
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "sensitive").unwrap();
        fs::remove_file(plugin_dir.join("grammars/test.tmLanguage.json")).unwrap();
        std::os::unix::fs::symlink(&secret, plugin_dir.join("grammars/test.tmLanguage.json"))
            .unwrap();

        let registry = PluginRegistry::discover(dir.path());
        let result = read_grammar(&registry, "lang-test", "grammars/test.tmLanguage.json");
        assert!(matches!(
            result,
            Err(GrammarError::PathOutsidePlugin { .. })
        ));
    }

    /// Sanity: a `LoadedPlugin` is constructible enough to use the
    /// helper directly. Mostly a smoke test that the public types
    /// line up — exercised more thoroughly through `discover` above.
    #[test]
    fn loaded_plugin_smoke() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = LoadedPlugin {
            manifest: make_grammar_manifest("smoke"),
            dir: dir.path().to_path_buf(),
            config: HashMap::new(),
            cli_available: true,
            trust: crate::plugin_runtime::PluginTrust::Unknown,
        };
        // Just confirm we can read its fields.
        assert_eq!(plugin.manifest.name, "smoke");
        assert_eq!(plugin.manifest.languages[0].id, "test");
    }
}
