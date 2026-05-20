//! Allow-list for agent-managed files that live outside any worktree.
//!
//! Coding agents (Claude Code, Codex) persist plans, memory notes, and
//! related markdown under fixed directories in the user's home — never
//! inside a Claudette worktree. The worktree file-read commands reject
//! absolute paths by design, so those files can't be opened through the
//! normal editor route.
//!
//! This module is the *one* place that decides which out-of-worktree
//! paths are safe to read: a structured [`ROOTS`] allow-list plus a single
//! [`classify_agent_file`] entry point. Adding a new agent directory is
//! one [`AgentFileRoot`] entry — no new command, no forked validation.
//!
//! The matching is deliberately **component-wise** (whole path segments,
//! never a substring compare) and runs against the **canonicalized** path,
//! so symlink escapes resolve to their real location before matching.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// What kind of agent-managed file a path resolved to. Surfaced to the UI
/// as a small badge so the user can tell a plan from a memory note at a
/// glance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentFileKind {
    /// A plan file (`~/.claude/plans/**/*.md`).
    Plan,
    /// A memory note under an agent's memory directory.
    Memory,
    /// The conventional `MEMORY.md` index inside a memory directory.
    MemoryIndex,
    /// A markdown file under a Claude project directory that isn't a
    /// recognized memory file — the broad project catch.
    ProjectFile,
}

/// One segment of an allow-list anchor.
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
/// `anchor` is a run of consecutive path segments that must appear, in
/// order, somewhere in the canonical path. Any number of segments may
/// follow the anchor before the file itself (an implicit `**`), and at
/// least one must (the file).
struct AgentFileRoot {
    anchor: &'static [Seg],
    /// Allowed file extensions, lowercase, without the leading dot.
    extensions: &'static [&'static str],
    kind: AgentFileKind,
}

/// The allow-list. Evaluated top-to-bottom; the first matching root wins,
/// so the specific memory roots precede the broad project catch.
///
/// Keep this in sync with the frontend recognizer in
/// `src/ui/src/utils/agentFiles.ts`.
const ROOTS: &[AgentFileRoot] = &[
    // Claude Code plans — `~/.claude/plans/**/*.md`.
    AgentFileRoot {
        anchor: &[Lit(".claude"), Lit("plans")],
        extensions: &["md"],
        kind: AgentFileKind::Plan,
    },
    // Claude Code project memory — `~/.claude/projects/<slug>/memory/**/*.md`.
    AgentFileRoot {
        anchor: &[Lit(".claude"), Lit("projects"), Any, Lit("memory")],
        extensions: &["md"],
        kind: AgentFileKind::Memory,
    },
    // Codex memory — `~/.codex/memories/**/*.md`.
    AgentFileRoot {
        anchor: &[Lit(".codex"), Lit("memories")],
        extensions: &["md"],
        kind: AgentFileKind::Memory,
    },
    // Broad Claude Code project catch — any other `.md` under a project
    // directory (`~/.claude/projects/<slug>/**/*.md`).
    AgentFileRoot {
        anchor: &[Lit(".claude"), Lit("projects"), Any],
        extensions: &["md"],
        kind: AgentFileKind::ProjectFile,
    },
];

/// Classify `path` against the agent-managed-file allow-list.
///
/// The path is canonicalized first, fully resolving symlinks: a symlink
/// placed inside an allow-listed directory that points elsewhere resolves
/// to its real location and is rejected unless that location is itself
/// allow-listed.
///
/// Returns the canonical path together with its [`AgentFileKind`], or an
/// `Err` describing why the path was rejected. This is the security gate
/// for [`crate::file_expand::read_authorized_file`] — it does **not**
/// relax the worktree file-read boundary, it is a separate narrow route.
pub fn classify_agent_file(path: &Path) -> Result<(PathBuf, AgentFileKind), String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("Invalid agent file path: {e}"))?;

    if !canonical.is_file() {
        return Err("Agent file path is not a regular file".to_string());
    }

    let components: Vec<&str> = canonical
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    let extension = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);

    for root in ROOTS {
        let ext_ok = match extension.as_deref() {
            Some(ext) => root.extensions.contains(&ext),
            None => false,
        };
        if ext_ok && anchor_present(&components, root.anchor) {
            let kind = refine_kind(root.kind, &canonical);
            return Ok((canonical.clone(), kind));
        }
    }

    Err("Path is not an allow-listed agent-managed file".to_string())
}

/// True when `anchor` appears as a run of consecutive components in
/// `components`, with at least one component (the file itself) following
/// the run.
fn anchor_present(components: &[&str], anchor: &[Seg]) -> bool {
    let n = anchor.len();
    // Need the anchor window plus at least one trailing component.
    if components.len() <= n {
        return false;
    }
    let last_start = components.len() - n - 1;
    (0..=last_start).any(|start| {
        anchor
            .iter()
            .zip(&components[start..start + n])
            .all(|(seg, comp)| match seg {
                Seg::Lit(name) => comp == name,
                Seg::Any => true,
            })
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

    #[test]
    fn classifies_claude_plan() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/plans/sunny-otter.md");
        let (_canonical, kind) = classify_agent_file(&path).unwrap();
        assert_eq!(kind, AgentFileKind::Plan);
    }

    #[test]
    fn classifies_project_memory_note() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/projects/-Users-me-proj/memory/feedback_x.md");
        let (_canonical, kind) = classify_agent_file(&path).unwrap();
        assert_eq!(kind, AgentFileKind::Memory);
    }

    #[test]
    fn classifies_memory_index() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/projects/-Users-me-proj/memory/MEMORY.md");
        let (_canonical, kind) = classify_agent_file(&path).unwrap();
        assert_eq!(kind, AgentFileKind::MemoryIndex);
    }

    #[test]
    fn classifies_broad_project_markdown_as_project_file() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/projects/-Users-me-proj/scratch-notes.md");
        let (_canonical, kind) = classify_agent_file(&path).unwrap();
        assert_eq!(kind, AgentFileKind::ProjectFile);
    }

    #[test]
    fn classifies_codex_memory_and_index() {
        let dir = TempDir::new().unwrap();
        let note = touch(&dir, ".codex/memories/raw_memories.md");
        assert_eq!(classify_agent_file(&note).unwrap().1, AgentFileKind::Memory);
        let index = touch(&dir, ".codex/memories/MEMORY.md");
        assert_eq!(
            classify_agent_file(&index).unwrap().1,
            AgentFileKind::MemoryIndex
        );
        let nested = touch(&dir, ".codex/memories/rollout_summaries/2026-05-12-foo.md");
        assert_eq!(
            classify_agent_file(&nested).unwrap().1,
            AgentFileKind::Memory
        );
    }

    #[test]
    fn rejects_sibling_non_markdown_file() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, ".claude/plans/notes.txt");
        assert!(classify_agent_file(&path).is_err());
    }

    #[test]
    fn rejects_arbitrary_absolute_path() {
        let dir = TempDir::new().unwrap();
        let path = touch(&dir, "some/other/place/document.md");
        assert!(classify_agent_file(&path).is_err());
    }

    #[test]
    fn rejects_missing_path() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".claude/plans/nonexistent.md");
        assert!(classify_agent_file(&path).is_err());
    }

    #[test]
    fn rejects_directory() {
        let dir = TempDir::new().unwrap();
        let memory_dir = dir.path().join(".claude/plans/looks-like.md");
        fs::create_dir_all(&memory_dir).unwrap();
        assert!(classify_agent_file(&memory_dir).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let dir = TempDir::new().unwrap();
        // A real file outside any allow-listed root.
        let secret = touch(&dir, "outside/secret.md");
        // A symlink planted inside an allow-listed directory pointing at it.
        let link_dir = dir.path().join(".claude/plans");
        fs::create_dir_all(&link_dir).unwrap();
        let link = link_dir.join("escape.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        // The symlink resolves (via canonicalize) to the real file, which
        // has no `.claude/plans` segment — so it must be rejected.
        assert!(classify_agent_file(&link).is_err());
    }
}
