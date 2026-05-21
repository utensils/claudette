use super::attachments::{
    cleanup_stale_attachments_at, create_staging_dir, extension_for_media_type, html_escape,
    sanitize_stem, write_attachment_to_temp_file, write_bytes_to_absolute_path,
    write_image_as_html,
};
use super::listing::{
    MAX_IGNORED_FILES_PER_TOP_DIR, collect_workspace_file_entries, is_high_volume_path,
    top_level_bucket,
};
use super::workspace_ops::{
    build_create_file_target, build_rename_target, resolve_existing_workspace_path,
    resolve_workspace_target_path,
};
use std::path::Path;
use tempfile::tempdir;

#[tokio::test]
async fn list_includes_gitignored_files() {
    let dir = tempdir().unwrap();
    let root = dir.path();

    // Bootstrap a minimal git repo with one commit so HEAD exists.
    for args in [
        vec!["init"],
        vec!["config", "user.email", "test@test.com"],
        vec!["config", "user.name", "Test"],
    ] {
        claudette::process::std_command("git")
            .args(&args)
            .current_dir(root)
            .output()
            .unwrap();
    }
    std::fs::write(root.join("tracked.txt"), "hello").unwrap();
    for args in [vec!["add", "tracked.txt"], vec!["commit", "-m", "init"]] {
        claudette::process::std_command("git")
            .args(&args)
            .current_dir(root)
            .output()
            .unwrap();
    }

    // Create a gitignored file that an agent might produce for local use.
    std::fs::write(root.join(".gitignore"), "local-notes.md\n").unwrap();
    std::fs::write(root.join("local-notes.md"), "agent docs").unwrap();

    let entries = collect_workspace_file_entries(&root.to_string_lossy())
        .await
        .unwrap();

    let files: Vec<&str> = entries
        .iter()
        .filter(|e| !e.is_directory)
        .map(|e| e.path.as_str())
        .collect();
    assert!(files.contains(&"tracked.txt"), "tracked file must appear");
    assert!(
        files.contains(&"local-notes.md"),
        "gitignored file must appear; got: {files:?}"
    );

    let ignored = entries.iter().find(|e| e.path == "local-notes.md").unwrap();
    assert!(
        ignored.git_status.is_none(),
        "gitignored file should carry no git status badge"
    );
}

#[test]
fn high_volume_path_matches_known_dirs() {
    assert!(is_high_volume_path("node_modules/react/index.js"));
    assert!(is_high_volume_path("target/debug/build/foo"));
    assert!(is_high_volume_path(".next/static/chunks/main.js"));
    assert!(!is_high_volume_path("src/node_modules_helper.rs"));
    assert!(!is_high_volume_path("mytarget/foo"));
}

#[test]
fn top_level_bucket_extracts_first_segment() {
    assert_eq!(top_level_bucket(".direnv/bin/python"), ".direnv/");
    assert_eq!(top_level_bucket("src/main.rs"), "src/");
    assert_eq!(top_level_bucket("Cargo.toml"), "");
    assert_eq!(top_level_bucket(""), "");
}

#[tokio::test]
async fn ignored_tree_does_not_starve_tracked_files() {
    // Regression for the post-#694 symptom where a single noisy
    // ignored top-level directory (`.codex/`, `.direnv/`, etc.) sorts
    // alphabetically before tracked content and consumed the
    // `MAX_FILES` cap, producing a Files panel that showed only
    // ignored directories.
    let dir = tempdir().unwrap();
    let root = dir.path();

    for args in [
        vec!["init"],
        vec!["config", "user.email", "test@test.com"],
        vec!["config", "user.name", "Test"],
    ] {
        claudette::process::std_command("git")
            .args(&args)
            .current_dir(root)
            .output()
            .unwrap();
    }

    // Tracked files at lowercase + uppercase top-level paths so any
    // alphabetical-truncation regression would hide them behind
    // `.heavy_ignored/` in collated order.
    std::fs::write(root.join("Cargo.toml"), "x").unwrap();
    std::fs::write(root.join("README.md"), "x").unwrap();
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("src").join("main.rs"), "x").unwrap();

    for args in [
        vec!["add", "Cargo.toml", "README.md", "src/main.rs"],
        vec!["commit", "-m", "init"],
    ] {
        claudette::process::std_command("git")
            .args(&args)
            .current_dir(root)
            .output()
            .unwrap();
    }

    // Heavy ignored tree: cap (200) + headroom worth of files in a
    // dot-prefixed dir so it sorts first.
    std::fs::write(root.join(".gitignore"), ".heavy_ignored/\n").unwrap();
    std::fs::create_dir(root.join(".heavy_ignored")).unwrap();
    let extra = MAX_IGNORED_FILES_PER_TOP_DIR + 50;
    for i in 0..extra {
        std::fs::write(
            root.join(".heavy_ignored").join(format!("f_{i:05}.dat")),
            "",
        )
        .unwrap();
    }

    let entries = collect_workspace_file_entries(&root.to_string_lossy())
        .await
        .unwrap();
    let files: Vec<&str> = entries
        .iter()
        .filter(|e| !e.is_directory)
        .map(|e| e.path.as_str())
        .collect();

    assert!(
        files.contains(&"Cargo.toml"),
        "tracked Cargo.toml must survive heavy ignored tree; got: {files:?}"
    );
    assert!(
        files.contains(&"README.md"),
        "tracked README.md must survive heavy ignored tree"
    );
    assert!(
        files.contains(&"src/main.rs"),
        "tracked src/main.rs must survive heavy ignored tree"
    );

    let ignored_in_heavy = files
        .iter()
        .filter(|p| p.starts_with(".heavy_ignored/"))
        .count();
    assert!(
        ignored_in_heavy <= MAX_IGNORED_FILES_PER_TOP_DIR,
        "ignored bucket must be capped at {MAX_IGNORED_FILES_PER_TOP_DIR}; got {ignored_in_heavy}"
    );
    assert!(
        ignored_in_heavy > 0,
        "ignored bucket should still surface some entries so the user knows the directory exists"
    );
}

#[test]
fn write_bytes_to_absolute_path_creates_parent_dirs() {
    let dir = tempdir().unwrap();
    let nested = dir.path().join("sub").join("dir").join("out.bin");
    write_bytes_to_absolute_path(&nested, b"hello").unwrap();
    assert_eq!(std::fs::read(&nested).unwrap(), b"hello");
}

#[test]
fn write_bytes_to_absolute_path_rejects_relative() {
    let err = write_bytes_to_absolute_path(Path::new("relative.bin"), b"x").unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
}

#[test]
fn write_bytes_to_absolute_path_overwrites_existing() {
    let dir = tempdir().unwrap();
    let p = dir.path().join("file.bin");
    write_bytes_to_absolute_path(&p, b"first").unwrap();
    write_bytes_to_absolute_path(&p, b"second").unwrap();
    assert_eq!(std::fs::read(&p).unwrap(), b"second");
}

#[test]
fn write_image_as_html_embeds_data_url() {
    let dir = tempdir().unwrap();
    let path = write_image_as_html(dir.path(), "cat photo.png", "image/png", b"\x89PNG").unwrap();
    assert_eq!(path.extension().unwrap(), "html");
    let content = std::fs::read_to_string(&path).unwrap();
    assert!(
        content.contains("data:image/png;base64,iVBORw==")
            || content.contains("data:image/png;base64,")
    );
    assert!(content.contains("<title>cat photo.png</title>"));
}

#[test]
fn write_image_as_html_escapes_hostile_media_type() {
    let dir = tempdir().unwrap();
    let path =
        write_image_as_html(dir.path(), "x", "image/png\" onload=\"alert(1)", b"\x89PNG").unwrap();
    let content = std::fs::read_to_string(&path).unwrap();
    assert!(!content.contains("onload=\"alert(1)"));
    assert!(content.contains("&quot;"));
}

#[test]
fn write_image_as_html_uses_unique_suffix() {
    let dir = tempdir().unwrap();
    let p1 = write_image_as_html(dir.path(), "x", "image/png", b"a").unwrap();
    std::thread::sleep(std::time::Duration::from_nanos(1));
    let p2 = write_image_as_html(dir.path(), "x", "image/png", b"b").unwrap();
    assert_ne!(p1, p2);
}

#[test]
fn sanitize_stem_replaces_unsafe_chars() {
    assert_eq!(sanitize_stem("hello world.png"), "hello_world_png");
    assert_eq!(sanitize_stem("../../etc/passwd"), "______etc_passwd");
    assert_eq!(sanitize_stem(""), "attachment");
}

#[test]
fn html_escape_handles_special_chars() {
    assert_eq!(html_escape(r#"a<b>&"c"#), "a&lt;b&gt;&amp;&quot;c");
}

#[test]
fn extension_for_media_type_picks_pdf_for_pdf_type() {
    assert_eq!(extension_for_media_type("application/pdf"), "pdf");
}

#[test]
fn extension_for_media_type_uses_real_extensions_not_subtypes() {
    // text/plain → txt (not "plain"); subtypes that aren't valid file
    // extensions get a sensible mapping so the OS routes to the right
    // viewer/editor.
    assert_eq!(extension_for_media_type("text/plain"), "txt");
    assert_eq!(extension_for_media_type("application/json"), "json");
    assert_eq!(extension_for_media_type("application/ld+json"), "json");
    assert_eq!(extension_for_media_type("text/html"), "html");
}

#[test]
fn extension_for_media_type_strips_xml_suffix() {
    assert_eq!(extension_for_media_type("image/svg+xml"), "svg");
}

#[test]
fn extension_for_media_type_falls_back_to_bin_for_opaque_types() {
    assert_eq!(
        extension_for_media_type("application/x-something weird"),
        "bin"
    );
}

#[test]
fn write_attachment_to_temp_file_uses_natural_extension() {
    let dir = tempdir().unwrap();
    let path = write_attachment_to_temp_file(
        dir.path(),
        "claude-system-card.pdf",
        "application/pdf",
        b"%PDF-1.4 fake",
    )
    .unwrap();
    assert_eq!(path.extension().unwrap(), "pdf");
    assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.4 fake");
}

#[test]
fn write_attachment_to_temp_file_sanitizes_filename() {
    let dir = tempdir().unwrap();
    let path =
        write_attachment_to_temp_file(dir.path(), "hello world.pdf", "application/pdf", b"%PDF")
            .unwrap();
    let stem = path.file_stem().unwrap().to_str().unwrap();
    assert!(!stem.contains(' '));
    assert!(stem.starts_with("hello_world"));
}

#[test]
fn write_attachment_to_temp_file_uses_unique_suffix() {
    let dir = tempdir().unwrap();
    let p1 = write_attachment_to_temp_file(dir.path(), "doc.pdf", "application/pdf", b"a").unwrap();
    std::thread::sleep(std::time::Duration::from_nanos(1));
    let p2 = write_attachment_to_temp_file(dir.path(), "doc.pdf", "application/pdf", b"b").unwrap();
    assert_ne!(p1, p2);
}

#[cfg(unix)]
#[test]
fn write_attachment_to_temp_file_uses_owner_only_perms() {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempdir().unwrap();
    let path = write_attachment_to_temp_file(dir.path(), "secret.pdf", "application/pdf", b"%PDF")
        .unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    // Only the owner should be able to read the staged file — these
    // can contain user data that other local accounts shouldn't see.
    assert_eq!(mode, 0o600, "expected 0o600, got {mode:o}");
}

#[test]
fn cleanup_stale_attachments_removes_old_files() {
    use std::time::Duration;
    let dir = tempdir().unwrap();
    let old_path = dir.path().join("old.pdf");
    let fresh_path = dir.path().join("fresh.pdf");
    std::fs::write(&old_path, b"old").unwrap();
    // Sleep so the fresh file has a strictly newer mtime than the old
    // one (file system mtime resolution is ~1 ms on most platforms).
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(&fresh_path, b"fresh").unwrap();

    // Pretend "now" is far in the future, just past the fresh file's
    // mtime — the old file lands beyond the cleanup threshold while
    // the fresh one is still inside it.
    let fresh_mtime = std::fs::metadata(&fresh_path).unwrap().modified().unwrap();
    let now = fresh_mtime + Duration::from_millis(5);
    cleanup_stale_attachments_at(dir.path(), Duration::from_millis(15), now);

    assert!(!old_path.exists(), "old file should be removed");
    assert!(fresh_path.exists(), "fresh file should be kept");
}

#[test]
fn cleanup_stale_attachments_is_noop_when_dir_missing() {
    // Must not panic / error when the staging directory hasn't been
    // created yet (first ever open after install).
    let dir = tempdir().unwrap();
    let missing = dir.path().join("does-not-exist");
    cleanup_stale_attachments_at(
        &missing,
        std::time::Duration::from_secs(0),
        std::time::SystemTime::now(),
    );
}

#[test]
fn create_staging_dir_creates_when_missing() {
    let parent = tempdir().unwrap();
    let target = parent.path().join("claudette-staging");
    assert!(!target.exists());
    create_staging_dir(&target).unwrap();
    assert!(target.is_dir());
}

#[test]
fn create_staging_dir_rejects_a_regular_file_at_the_path() {
    let parent = tempdir().unwrap();
    let target = parent.path().join("not-a-dir");
    std::fs::write(&target, b"oops").unwrap();
    let err = create_staging_dir(&target).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
}

#[cfg(unix)]
#[test]
fn create_staging_dir_tightens_permissions_on_existing_dir() {
    use std::os::unix::fs::PermissionsExt as _;
    let parent = tempdir().unwrap();
    let target = parent.path().join("loose-dir");
    // Pre-create with a wider mode (e.g. a previous run with a
    // permissive umask).
    std::fs::create_dir(&target).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
    create_staging_dir(&target).unwrap();
    let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700, "expected 0o700, got {mode:o}");
}

#[test]
fn rename_target_rejects_invalid_names() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("file.txt"), "hello").unwrap();

    for name in ["", "   ", ".", "..", "a/b", r"a\b"] {
        let err = build_rename_target(dir.path(), "file.txt", name).unwrap_err();
        assert!(!err.is_empty());
    }
}

#[test]
fn rename_target_rejects_path_escape() {
    let dir = tempdir().unwrap();
    let err = build_rename_target(dir.path(), "../file.txt", "next.txt").unwrap_err();
    assert!(err.contains("escapes worktree"), "got: {err}");
}

#[test]
fn rename_target_rejects_absolute_source_paths() {
    let dir = tempdir().unwrap();
    let err = build_rename_target(dir.path(), "/file.txt", "next.txt").unwrap_err();
    assert!(err.contains("absolute paths"), "got: {err}");
}

#[test]
fn rename_target_rejects_collisions() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
    std::fs::write(dir.path().join("other.txt"), "world").unwrap();

    let err = build_rename_target(dir.path(), "file.txt", "other.txt").unwrap_err();
    assert!(err.contains("already exists"), "got: {err}");
}

#[test]
fn rename_target_keeps_file_in_same_parent() {
    let dir = tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    std::fs::write(dir.path().join("sub").join("file.txt"), "hello").unwrap();

    let target = build_rename_target(dir.path(), "sub/file.txt", "other.txt").unwrap();

    assert_eq!(target.relative, "sub/other.txt");
    assert_eq!(
        target.absolute,
        dir.path()
            .join("sub")
            .canonicalize()
            .unwrap()
            .join("other.txt")
    );
}

#[test]
fn rename_target_handles_directory_paths_with_trailing_slash() {
    let dir = tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();

    let target = build_rename_target(dir.path(), "sub/", "renamed").unwrap();

    assert_eq!(target.relative, "renamed");
    assert_eq!(
        target.absolute,
        dir.path().canonicalize().unwrap().join("renamed")
    );
}

#[test]
fn create_file_target_allows_root_parent() {
    let dir = tempdir().unwrap();

    let target = build_create_file_target(dir.path(), "", "new.txt").unwrap();

    assert_eq!(target.relative, "new.txt");
    assert_eq!(
        target.absolute,
        dir.path().canonicalize().unwrap().join("new.txt")
    );
}

#[test]
fn create_file_target_rejects_collisions_and_nested_names() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("existing.txt"), "hello").unwrap();

    let collision = build_create_file_target(dir.path(), "", "existing.txt").unwrap_err();
    assert!(collision.contains("already exists"), "got: {collision}");

    let nested = build_create_file_target(dir.path(), "", "nested/file.txt").unwrap_err();
    assert!(nested.contains("separators"), "got: {nested}");
}

#[test]
fn create_file_target_requires_existing_directory_parent() {
    let dir = tempdir().unwrap();
    std::fs::write(dir.path().join("file.txt"), "hello").unwrap();

    let err = build_create_file_target(dir.path(), "file.txt", "child.txt").unwrap_err();

    assert!(err.contains("parent is not a directory"), "got: {err}");
}

#[test]
fn resolve_existing_workspace_path_identifies_directories() {
    let dir = tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();

    let resolved = resolve_existing_workspace_path(dir.path(), "sub/").unwrap();

    assert_eq!(resolved.relative, "sub");
    assert!(resolved.is_directory);
    assert_eq!(
        resolved.absolute,
        dir.path().join("sub").canonicalize().unwrap()
    );
}

#[test]
fn resolve_workspace_target_path_allows_missing_leaf() {
    let dir = tempdir().unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();

    let resolved = resolve_workspace_target_path(dir.path(), "sub/restored.txt").unwrap();

    assert_eq!(resolved.relative, "sub/restored.txt");
    assert_eq!(
        resolved.absolute,
        dir.path()
            .join("sub")
            .canonicalize()
            .unwrap()
            .join("restored.txt")
    );
}

#[test]
fn resolve_workspace_target_path_rejects_missing_parent() {
    let dir = tempdir().unwrap();

    let err = resolve_workspace_target_path(dir.path(), "missing/restored.txt").unwrap_err();

    assert!(err.contains("canonicalize parent"), "got: {err}");
}
