//! Data types for the community registry — themes, plugins, and
//! grammars Claudette can install from `utensils/claudette-community`.
//!
//! Schema mirrors `registry.schema.json` in that repo. Field naming
//! uses snake_case in Rust; serde renames apply where the JSON uses
//! kebab-case discriminants (`source.type`, `kind` values).
//!
//! See TDD #567 for the complete design.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Top-level registry index. Claudette fetches this once, parses it,
/// and renders contributions for browsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registry {
    /// Schema version — currently `1`. Bumped only on breaking changes.
    pub version: u32,
    /// ISO-8601 timestamp the registry was last regenerated. Informational.
    pub generated_at: String,
    /// The community repo + commit the registry was built from. Used to
    /// resolve in-tree contribution tarballs from
    /// `codeload.github.com/<repo>/tar.gz/<sha>`.
    pub source: RegistrySource,
    pub themes: Vec<ThemeEntry>,
    pub plugins: PluginsByKind,
    /// Forthcoming kinds — registry surfaces empty arrays today.
    #[serde(default)]
    pub slash_commands: Vec<serde_json::Value>,
    #[serde(default)]
    pub mcp_recipes: Vec<serde_json::Value>,
}

/// Identity of the community repo + commit a registry was generated from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrySource {
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub sha: String,
}

/// Plugin entries grouped by `PluginKind` discriminant. Mirrors the
/// JSON shape `plugins.scm[]`, `plugins.env-provider[]`,
/// `plugins.language-grammar[]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginsByKind {
    pub scm: Vec<PluginEntry>,
    #[serde(rename = "env-provider")]
    pub env_provider: Vec<PluginEntry>,
    #[serde(rename = "language-grammar")]
    pub language_grammar: Vec<PluginEntry>,
}

/// A theme contribution. Themes are always `in-tree` in v1 — the
/// schema rejects `external` themes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color_scheme: ColorScheme,
    pub accent_preview: String,
    pub version: String,
    pub author: String,
    pub license: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub submitted_at: String,
    pub source: ContributionSource,
}

/// A plugin contribution. May be in-tree (themes/grammars/simple
/// plugins authored inside `claudette-community`) or external (Lua
/// plugins authored in their own repos, mirrored into `mirrors/`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginEntry {
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub kind: PluginKindWire,
    #[serde(default)]
    pub required_clis: Vec<String>,
    #[serde(default)]
    pub remote_patterns: Vec<String>,
    #[serde(default)]
    pub operations: Vec<String>,
    #[serde(default)]
    pub config_schema: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub settings: Vec<serde_json::Value>,
    #[serde(default)]
    pub languages: Vec<serde_json::Value>,
    #[serde(default)]
    pub grammars: Vec<serde_json::Value>,
    pub author: String,
    pub license: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub submitted_at: String,
    pub source: ContributionSource,
}

/// On-the-wire plugin kind values (kebab-case strings the registry
/// JSON uses — distinct from the Rust [`crate::plugin_runtime::manifest::PluginKind`]
/// enum which is consumed only after the contribution is installed
/// and parsed by the runtime).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginKindWire {
    Scm,
    EnvProvider,
    LanguageGrammar,
}

impl PluginKindWire {
    /// The kind directory name in `claudette-community` for this kind.
    pub fn kind_dir(self) -> &'static str {
        match self {
            Self::Scm => "scm",
            Self::EnvProvider => "env-providers",
            Self::LanguageGrammar => "language-grammars",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ColorScheme {
    Dark,
    Light,
}

/// Where the contribution's source files live + how to verify them.
///
/// `in-tree`: files are in `claudette-community` itself at `path` as of
/// the registry's `source.sha`. Fetch via the codeload tarball.
///
/// `external`: files are in the author's own repo. The community repo
/// keeps a tarball mirror at `mirror_path`; Claudette fetches the
/// mirror, never the upstream directly.
///
/// In both cases `sha256` is the content hash (see
/// [`super::verify`]) and is the trust anchor — `sha` is advisory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ContributionSource {
    InTree {
        path: String,
        sha: String,
        sha256: String,
    },
    External {
        git_url: String,
        git_ref: String,
        sha: String,
        sha256: String,
        mirror_path: String,
    },
}

impl ContributionSource {
    pub fn sha256(&self) -> &str {
        match self {
            Self::InTree { sha256, .. } => sha256,
            Self::External { sha256, .. } => sha256,
        }
    }

    pub fn sha(&self) -> &str {
        match self {
            Self::InTree { sha, .. } => sha,
            Self::External { sha, .. } => sha,
        }
    }
}

/// What gets written to `<install-dir>/.install_meta.json` after an
/// install or update. Lets us detect drift, surface updates, and
/// (in PR #4 of #567) track granted capabilities for re-consent on
/// update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledMeta {
    /// `"community"` — installed via the registry, identifiable
    /// in the existing plugin loader so we know not to treat it as a
    /// hand-edited user plugin. (`"direct"` and `"bundled"` are
    /// reserved for future use.)
    pub source: InstallSource,
    /// `Registry.source.sha` at install time — used by the regen
    /// flow to know which registry generation we resolved against.
    pub registry_sha: String,
    /// Per-contribution `source.sha`. Advances with the contribution.
    pub contribution_sha: String,
    /// The verified content hash of what we wrote. Recomputed on
    /// disk during update-check; mismatch flags tampering or partial
    /// install.
    pub sha256: String,
    /// ISO-8601 install timestamp.
    pub installed_at: String,
    /// `required_clis` at install time — diffed against the manifest
    /// at update time. Reserved for capability re-consent (PR #4).
    #[serde(default)]
    pub granted_capabilities: Vec<String>,
    /// Manifest `version` at install time.
    pub version: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InstallSource {
    Community,
    Direct,
    Bundled,
}

impl Registry {
    /// Find a contribution by kind and name/id. Returns `None` if
    /// neither side has it.
    pub fn lookup(&self, kind: ContributionKind, ident: &str) -> Option<ContributionRef<'_>> {
        match kind {
            ContributionKind::Theme => self
                .themes
                .iter()
                .find(|t| t.id == ident)
                .map(ContributionRef::Theme),
            ContributionKind::Plugin(PluginKindWire::Scm) => self
                .plugins
                .scm
                .iter()
                .find(|p| p.name == ident)
                .map(ContributionRef::Plugin),
            ContributionKind::Plugin(PluginKindWire::EnvProvider) => self
                .plugins
                .env_provider
                .iter()
                .find(|p| p.name == ident)
                .map(ContributionRef::Plugin),
            ContributionKind::Plugin(PluginKindWire::LanguageGrammar) => self
                .plugins
                .language_grammar
                .iter()
                .find(|p| p.name == ident)
                .map(ContributionRef::Plugin),
        }
    }
}

/// Top-level discriminator used by Tauri command APIs and lookups.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContributionKind {
    Theme,
    Plugin(PluginKindWire),
}

impl ContributionKind {
    /// Wire form: `"theme"`, `"plugin:scm"`, `"plugin:env-provider"`,
    /// `"plugin:language-grammar"`.
    pub fn wire(&self) -> String {
        match self {
            Self::Theme => "theme".into(),
            Self::Plugin(k) => format!(
                "plugin:{}",
                match k {
                    PluginKindWire::Scm => "scm",
                    PluginKindWire::EnvProvider => "env-provider",
                    PluginKindWire::LanguageGrammar => "language-grammar",
                }
            ),
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "theme" => Some(Self::Theme),
            "plugin:scm" => Some(Self::Plugin(PluginKindWire::Scm)),
            "plugin:env-provider" => Some(Self::Plugin(PluginKindWire::EnvProvider)),
            "plugin:language-grammar" => Some(Self::Plugin(PluginKindWire::LanguageGrammar)),
            _ => None,
        }
    }
}

/// Borrowed reference to a contribution from a registry. Used by lookup
/// helpers when the caller needs the source/metadata without cloning.
#[derive(Debug)]
pub enum ContributionRef<'a> {
    Theme(&'a ThemeEntry),
    Plugin(&'a PluginEntry),
}

impl ContributionRef<'_> {
    pub fn source(&self) -> &ContributionSource {
        match self {
            Self::Theme(t) => &t.source,
            Self::Plugin(p) => &p.source,
        }
    }

    /// Identity used as the directory name on disk —
    /// theme `id` or plugin `name`.
    pub fn ident(&self) -> &str {
        match self {
            Self::Theme(t) => &t.id,
            Self::Plugin(p) => &p.name,
        }
    }

    pub fn version(&self) -> &str {
        match self {
            Self::Theme(t) => &t.version,
            Self::Plugin(p) => &p.version,
        }
    }

    /// Capability list at registry-snapshot time — for plugins this
    /// is `required_clis`; themes have no capabilities.
    pub fn capabilities(&self) -> Vec<String> {
        match self {
            Self::Theme(_) => Vec::new(),
            Self::Plugin(p) => p.required_clis.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_registry_with_lang_nix() {
        // The shape produced by claudette-community's generator with
        // a single in-tree language-grammar contribution.
        let json = r#"{
            "version": 1,
            "generated_at": "2026-05-02T06:00:00.000Z",
            "source": {
                "repo": "utensils/claudette-community",
                "ref": "main",
                "sha": "0000000000000000000000000000000000000000"
            },
            "themes": [],
            "plugins": {
                "scm": [],
                "env-provider": [],
                "language-grammar": [{
                    "name": "lang-nix",
                    "display_name": "Nix",
                    "version": "1.0.0",
                    "description": "Nix language",
                    "kind": "language-grammar",
                    "operations": [],
                    "author": "utensils",
                    "license": "MIT",
                    "submitted_at": "2026-05-01",
                    "source": {
                        "type": "in-tree",
                        "path": "plugins/language-grammars/lang-nix",
                        "sha": "1111111111111111111111111111111111111111",
                        "sha256": "deadbeef00000000000000000000000000000000000000000000000000000000"
                    },
                    "languages": [{"id": "nix", "extensions": [".nix"], "aliases": ["Nix"]}],
                    "grammars": [{"language": "nix", "scope_name": "source.nix", "path": "grammars/nix.tmLanguage.json"}]
                }]
            }
        }"#;
        let reg: Registry = serde_json::from_str(json).expect("parse");
        assert_eq!(reg.version, 1);
        assert_eq!(reg.plugins.language_grammar.len(), 1);
        let p = &reg.plugins.language_grammar[0];
        assert_eq!(p.name, "lang-nix");
        assert_eq!(p.kind, PluginKindWire::LanguageGrammar);
        assert_eq!(
            p.source.sha256(),
            "deadbeef00000000000000000000000000000000000000000000000000000000"
        );
        match &p.source {
            ContributionSource::InTree { path, .. } => {
                assert_eq!(path, "plugins/language-grammars/lang-nix");
            }
            _ => panic!("expected in-tree"),
        }
    }

    #[test]
    fn lookup_finds_plugin_by_kind_and_name() {
        let reg: Registry = serde_json::from_str(EXAMPLE_REGISTRY).unwrap();
        let r = reg
            .lookup(
                ContributionKind::Plugin(PluginKindWire::LanguageGrammar),
                "lang-nix",
            )
            .expect("found");
        assert_eq!(r.ident(), "lang-nix");
        assert_eq!(r.version(), "1.0.0");
        assert!(r.capabilities().is_empty());
    }

    #[test]
    fn lookup_returns_none_for_missing() {
        let reg: Registry = serde_json::from_str(EXAMPLE_REGISTRY).unwrap();
        assert!(
            reg.lookup(ContributionKind::Theme, "does-not-exist")
                .is_none()
        );
    }

    #[test]
    fn contribution_kind_wire_roundtrip() {
        for k in [
            ContributionKind::Theme,
            ContributionKind::Plugin(PluginKindWire::Scm),
            ContributionKind::Plugin(PluginKindWire::EnvProvider),
            ContributionKind::Plugin(PluginKindWire::LanguageGrammar),
        ] {
            let wire = k.wire();
            let back = ContributionKind::from_wire(&wire).unwrap();
            assert_eq!(k, back);
        }
    }

    #[test]
    fn from_wire_rejects_unknown() {
        assert!(ContributionKind::from_wire("plugin:unknown").is_none());
        assert!(ContributionKind::from_wire("theme:dark").is_none());
        assert!(ContributionKind::from_wire("").is_none());
    }

    #[test]
    fn external_source_roundtrips() {
        let json = r#"{
            "type": "external",
            "git_url": "https://github.com/foo/bar.git",
            "git_ref": "v1.0.0",
            "sha": "1234567890123456789012345678901234567890",
            "sha256": "00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff",
            "mirror_path": "mirrors/foo-bar-1234.tar.gz"
        }"#;
        let s: ContributionSource = serde_json::from_str(json).unwrap();
        match &s {
            ContributionSource::External { mirror_path, .. } => {
                assert_eq!(mirror_path, "mirrors/foo-bar-1234.tar.gz");
            }
            _ => panic!("expected external"),
        }
        let reser = serde_json::to_string(&s).unwrap();
        assert!(reser.contains(r#""type":"external""#));
    }

    const EXAMPLE_REGISTRY: &str = r#"{
        "version": 1,
        "generated_at": "2026-05-02T06:00:00.000Z",
        "source": {
            "repo": "utensils/claudette-community",
            "ref": "main",
            "sha": "0000000000000000000000000000000000000000"
        },
        "themes": [],
        "plugins": {
            "scm": [],
            "env-provider": [],
            "language-grammar": [{
                "name": "lang-nix", "display_name": "Nix", "version": "1.0.0",
                "description": "x", "kind": "language-grammar", "operations": [],
                "author": "utensils", "license": "MIT", "submitted_at": "2026-05-01",
                "source": {
                    "type": "in-tree",
                    "path": "plugins/language-grammars/lang-nix",
                    "sha": "1111111111111111111111111111111111111111",
                    "sha256": "deadbeef00000000000000000000000000000000000000000000000000000000"
                }
            }]
        }
    }"#;
}
