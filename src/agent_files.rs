//! Allow-list for agent-managed files that live outside any worktree.
//!
//! Coding agents (Claude Code, Codex) persist plans, memory notes, and
//! related markdown under fixed directories in the user's agent config —
//! never inside a Claudette worktree. The worktree file-read commands
//! reject absolute paths by design, so those files can't be opened
//! through the normal editor route.
//!
//! This module is the *one* place that decides which out-of-worktree
//! paths are safe to read: a structured [`ROOTS`] allow-list plus a single
//! [`classify_agent_file`] entry point. Adding a new agent directory is
//! one [`AgentFileRoot`] entry — no new command, no forked validation.
//!
//! Each root is anchored at an agent's **base directory**, resolved the
//! same way the agent's own CLI resolves it:
//! - Claude Code: `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`
//! - Codex: `$CODEX_HOME` if set, else `~/.codex`
//!
//! A candidate path must canonicalize (resolving symlinks) to a location
//! **under** one of those base directories, with the root's sub-path
//! rooted directly at the base — not merely containing the segments
//! somewhere. This rejects unrelated files under similarly-named
//! directories elsewhere on disk, and resolves symlink escapes to their
//! real location before the containment check.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// What kind of agent-managed file a path resolved to. Surfaced to the UI
/// as a small badge so the user can tell a plan from a memory note at a
/// glance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentFileKind {
    /// A plan file (`<claude-config>/plans/**/*.md`).
    Plan,
    /// A memory note under an agent's memory directory.
    Memory,
    /// The conventional `MEMORY.md` index inside a memory directory.
    MemoryIndex,
    /// A markdown file under a Claude project directory that isn't a
    /// recognized memory file — the broad project catch.
    ProjectFile,
}

/// An agent whose config/home directory anchors one or more roots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentBase {
    /// Claude Code config dir — `$CLAUDE_CONFIG_DIR` or `~/.claude`.
    ClaudeConfig,
    /// Codex home dir — `$CODEX_HOME` or `~/.codex`.
    CodexHome,
}

/// One segment of an allow-list sub-path.
#[derive(Clone, Copy)]
enum Seg {
    /// Must equal this exact directory name.
    Lit(&'static str),
    /// Matches exactly one path segment of any name (e.g. a project slug).
    Any,
}

use Seg::{Any, Lit};

/// A directory family whose files are safe to open read-only.
///
/// `sub_path` is the run of path segments directly under the agent's base
/// directory — rooted at the base's first child, not matched anywhere.
/// Any number of segments may follow before the file itself (an implicit
/// `**`), and at least one must (the file).
struct AgentFileRoot {
    base: AgentBase,
    sub_path: &'static [Seg],
    /// Allowed file extensions, lowercase, without the leading dot.
    extensions: &'static [&'static str],
    kind: AgentFileKind,
}

/// The allow-list. Evaluated top-to-bottom; the first matching root wins,
/// so the specific memory root precedes the broad project catch.
///
/// Keep this in sync with the frontend recognizer in
/// `src/ui/src/utils/agentFiles.ts`.
const ROOTS: &[AgentFileRoot] = &[
    // Claude Code plans — `<claude-config>/plans/**/*.md`.
    AgentFileRoot {
        base: AgentBase::ClaudeConfig,
        sub_path: &[Lit("plans")],
        extensions: &["md"],
        kind: AgentFileKind::Plan,
    },
    // Claude Code project memory —
    // `<claude-config>/projects/<slug>/memory/**/*.md`.
    AgentFileRoot {
        base: AgentBase::ClaudeConfig,
        sub_path: &[Lit("projects"), Any, Lit("memory")],
        extensions: &["md"],
        kind: AgentFileKind::Memory,
    },
    // Codex memory — `<codex-home>/memories/**/*.md`.
    AgentFileRoot {
        base: AgentBase::CodexHome,
        sub_path: &[Lit("memories")],
        extensions: &["md"],
        kind: AgentFileKind::Memory,
    },
    // Broad Claude Code project catch — any other `.md` under a project
    // directory (`<claude-config>/projects/<slug>/**/*.md`).
    AgentFileRoot {
        base: AgentBase::ClaudeConfig,
        sub_path: &[Lit("projects"), Any],
        extensions: &["md"],
        kind: AgentFileKind::ProjectFile,
    },
];

/// Resolved base directories for the agent-managed-file roots.
struct AgentBases {
    claude_config: Option<PathBuf>,
    codex_home: Option<PathBuf>,
}

impl AgentBases {
    fn for_base(&self, base: AgentBase) -> Option<&Path> {
        match base {
            AgentBase::ClaudeConfig => self.claude_config.as_deref(),
            AgentBase::CodexHome => self.codex_home.as_deref(),
        }
    }
}

/// Resolve the agent base directories, honoring the same env overrides the
/// agents' own CLIs use (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). An empty env
/// value counts as unset — matching `fork::resolve_claude_projects_dir`.
///
/// Pure: env values and home dir are passed in, so the resolution is
/// testable without mutating process-global state.
fn resolve_agent_bases(
    claude_config_env: Option<OsString>,
    codex_home_env: Option<OsString>,
    home_dir: Option<PathBuf>,
) -> AgentBases {
    let override_dir =
        |env: Option<OsString>| env.filter(|value| !value.is_empty()).map(PathBuf::from);
    AgentBases {
        claude_config: override_dir(claude_config_env)
            .or_else(|| home_dir.as_ref().map(|home| home.join(".claude"))),
        codex_home: override_dir(codex_home_env)
            .or_else(|| home_dir.as_ref().map(|home| home.join(".codex"))),
    }
}

/// Classify `path` against the agent-managed-file allow-list.
///
/// The path is canonicalized first, fully resolving symlinks, then checked
/// for containment under a canonicalized agent base directory: a symlink
/// placed inside an allow-listed directory that points elsewhere resolves
/// to its real location and is rejected unless that location is itself
/// inside an allow-listed root.
///
/// Returns the canonical path together with its [`AgentFileKind`], or an
/// `Err` describing why the path was rejected. This is the security gate
/// for [`crate::file_expand::read_authorized_file`] — it does **not**
/// relax the worktree file-read boundary, it is a separate narrow route.
pub fn classify_agent_file(path: &Path) -> Result<(PathBuf, AgentFileKind), String> {
    let bases = resolve_agent_bases(
        std::env::var_os("CLAUDE_CONFIG_DIR"),
        std::env::var_os("CODEX_HOME"),
        dirs::home_dir(),
    );
    classify_agent_file_within(path, &bases)
}

/// Inner classifier with the base directories supplied explicitly, so
/// tests can anchor the roots at a temp directory.
fn classify_agent_file_within(
    path: &Path,
    bases: &AgentBases,
) -> Result<(PathBuf, AgentFileKind), String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("Invalid agent file path: {e}"))?;

    if !canonical.is_file() {
        return Err("Agent file path is not a regular file".to_string());
    }

    let extension = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);

    for root in ROOTS {
        let ext_ok = extension
            .as_deref()
            .is_some_and(|ext| root.extensions.contains(&ext));
        if !ext_ok {
            continue;
        }
        // Resolve and canonicalize the base directory. A missing base
        // (agent never used on this machine) simply can't contain files,
        // so skip the root rather than failing the whole classification.
        let Some(base) = bases.for_base(root.base) else {
            continue;
        };
        let Ok(base_canonical) = std::fs::canonicalize(base) else {
            continue;
        };
        // Containment check: the real file must live under the real base.
        let Ok(relative) = canonical.strip_prefix(&base_canonical) else {
            continue;
        };
        let segments: Vec<&str> = relative
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect();
        if sub_path_matches(&segments, root.sub_path) {
            return Ok((canonical.clone(), refine_kind(root.kind, &canonical)));
        }
    }

    Err("Path is not an allow-listed agent-managed file".to_string())
}

/// True when `sub_path` matches the leading components of `segments`, with
/// at least one trailing component (the file itself) after the match.
fn sub_path_matches(segments: &[&str], sub_path: &[Seg]) -> bool {
    let n = sub_path.len();
    // Need the sub-path segments plus at least one trailing component.
    if segments.len() <= n {
        return false;
    }
    sub_path.iter().zip(segments).all(|(seg, comp)| match seg {
        Seg::Lit(name) => comp == name,
        Seg::Any => true,
    })
}

/// Promote a generic `Memory` match to `MemoryIndex` when the file is the
/// conventional `MEMORY.md` index.
fn refine_kind(base: AgentFileKind, canonical: &Path) -> AgentFileKind {
    if base == AgentFileKind::Memory
        && canonical.file_name().and_then(|n| n.to_str()) == Some("MEMORY.md")
    {
        AgentFileKind::MemoryIndex
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Create a file (and any missing parent directories) under `dir`.
    fn touch(dir: &TempDir, relative: &str) -> PathBuf {
        let path = dir.path().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "# content\n").unwrap();
        path
    }

    /// Agent bases rooted at `<dir>/.claude` and `<dir>/.codex`.
    fn bases_under(dir: &TempDir) -> AgentBases {
        AgentBases {
            claude_config: Some(dir.path().join(".claude")),
            codex_home: Some(dir.path().join(".codex")),
        }
    }

    #[test]
    fn classifies_claude_plan() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/plans/sunny-otter.md");
        let (_canonical, kind) = classify_agent_file_within(&path, &bases_under(&dir)).unwrap();
        assert_eq!(kind, AgentFileKind::Plan);
    }

    #[test]
    fn classifies_project_memory_note() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/projects/-Users-me-proj/memory/feedback_x.md");
        let (_canonical, kind) = classify_agent_file_within(&path, &bases_under(&dir)).unwrap();
        assert_eq!(kind, AgentFileKind::Memory);
    }

    #[test]
    fn classifies_memory_index() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/projects/-Users-me-proj/memory/MEMORY.md");
        let (_canonical, kind) = classify_agent_file_within(&path, &bases_under(&dir)).unwrap();
        assert_eq!(kind, AgentFileKind::MemoryIndex);
    }

    #[test]
    fn classifies_broad_project_markdown_as_project_file() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/projects/-Users-me-proj/scratch-notes.md");
        let (_canonical, kind) = classify_agent_file_within(&path, &bases_under(&dir)).unwrap();
        assert_eq!(kind, AgentFileKind::ProjectFile);
    }

    #[test]
    fn classifies_codex_memory_and_index() {
        let dir = TempDir::new().unwrap();
        let bases = bases_under(&dir);

        let note = touch(&dir, ".codex/memories/raw_memories.md");
        assert_eq!(
            classify_agent_file_within(&note, &bases).unwrap().1,
            AgentFileKind::Memory
        );
        let index = touch(&dir, ".codex/memories/MEMORY.md");
        assert_eq!(
            classify_agent_file_within(&index, &bases).unwrap().1,
            AgentFileKind::MemoryIndex
        );
        let nested = touch(&dir, ".codex/memories/rollout_summaries/2026-05-12-foo.md");
        assert_eq!(
            classify_agent_file_within(&nested, &bases).unwrap().1,
            AgentFileKind::Memory
        );
    }

    #[test]
    fn rejects_sibling_non_markdown_file() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/plans/notes.txt");
        assert!(classify_agent_file_within(&path, &bases_under(&dir)).is_err());
    }

    #[test]
    fn rejects_arbitrary_absolute_path() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, "some/other/place/document.md");
        assert!(classify_agent_file_within(&path, &bases_under(&dir)).is_err());
    }

    #[test]
    fn rejects_lookalike_directory_outside_the_base() {
        // A `.claude/plans/*.md` file that is NOT under the resolved base
        // directory must be rejected — the anchor is the base dir, not the
        // mere presence of `.claude/plans` segments anywhere in the path.
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, "some-repo/.claude/plans/decoy.md");
        assert!(classify_agent_file_within(&path, &bases_under(&dir)).is_err());
    }

    #[test]
    fn rejects_missing_path() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude/plans/nonexistent.md");
        assert!(classify_agent_file_within(&path, &bases_under(&dir)).is_err());
    }

    #[test]
    fn rejects_directory() {
        let dir = TempDir::new().unwrap();
        let memory_dir = dir.path().join(".claude/plans/looks-like.md");
        fs::create_dir_all(&memory_dir).unwrap();
        assert!(classify_agent_file_within(&memory_dir, &bases_under(&dir)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let dir = TempDir::new().unwrap();
        // A real file outside any allow-listed base directory.
        let secret = touch(&dir, "outside/secret.md");
        // A symlink planted inside an allow-listed directory pointing at it.
        let link_dir = dir.path().join(".claude/plans");
        fs::create_dir_all(&link_dir).unwrap();
        let link = link_dir.join("escape.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        // The symlink resolves (via canonicalize) to the real file, which
        // is not under the base directory — so it must be rejected.
        assert!(classify_agent_file_within(&link, &bases_under(&dir)).is_err());
    }

    #[test]
    fn resolve_agent_bases_prefers_env_overrides() {
        let bases = resolve_agent_bases(
            Some(OsString::from("/sandbox/claude-config")),
            Some(OsString::from("/sandbox/codex")),
            Some(PathBuf::from("/home/me")),
        );
        assert_eq!(
            bases.claude_config.as_deref(),
            Some(Path::new("/sandbox/claude-config"))
        );
        assert_eq!(
            bases.codex_home.as_deref(),
            Some(Path::new("/sandbox/codex"))
        );
    }

    #[test]
    fn resolve_agent_bases_falls_back_to_home() {
        // Empty env values count as unset.
        let bases =
            resolve_agent_bases(Some(OsString::new()), None, Some(PathBuf::from("/home/me")));
        assert_eq!(
            bases.claude_config.as_deref(),
            Some(Path::new("/home/me/.claude"))
        );
        assert_eq!(
            bases.codex_home.as_deref(),
            Some(Path::new("/home/me/.codex"))
        );
    }

    #[test]
    fn classifies_under_env_overridden_base() {
        // Mirrors a `scripts/dev.sh` instance: the Claude config dir is a
        // sandbox path, not `~/.claude`. Plans there must still classify.
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, "claude-config/plans/dev-plan.md");
        let bases = AgentBases {
            claude_config: Some(dir.path().join("claude-config")),
            codex_home: None,
        };
        let (_canonical, kind) = classify_agent_file_within(&path, &bases).unwrap();
        assert_eq!(kind, AgentFileKind::Plan);
    }
}
