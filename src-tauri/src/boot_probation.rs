use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::sync::Notify;

const SENTINEL_FILE: &str = "boot-probation.json";
const REPORT_FILE: &str = "boot-rollback-report.json";
const PROBATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct BootProbationState {
    acknowledged: AtomicBool,
    cancel: Notify,
}

impl BootProbationState {
    pub fn acknowledge(&self) {
        self.acknowledged.store(true, Ordering::SeqCst);
        self.cancel.notify_waiters();
    }

    fn is_acknowledged(&self) -> bool {
        self.acknowledged.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InstallKind {
    MacApp,
    LinuxAppImage,
    WindowsInstallDir,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProbationStatus {
    Pending,
    RollbackInProgress,
    RollbackFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct BootProbation {
    pub status: ProbationStatus,
    pub failed_version: String,
    pub previous_version: String,
    pub download_url: String,
    pub install_kind: InstallKind,
    pub target_path: PathBuf,
    pub executable_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub backup_error: Option<String>,
    pub attempts: u32,
    pub data_dir: PathBuf,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct BootRollbackReport {
    pub failed_version: String,
    pub previous_version: String,
    pub download_url: String,
    pub restored: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InstallTarget {
    kind: InstallKind,
    target_path: PathBuf,
    executable_path: PathBuf,
    is_dir: bool,
}

pub fn sentinel_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SENTINEL_FILE)
}

pub fn report_path(data_dir: &Path) -> PathBuf {
    data_dir.join(REPORT_FILE)
}

pub fn updates_previous_dir(version: &str) -> PathBuf {
    claudette::path::claudette_home()
        .join("updates")
        .join("previous")
        .join(sanitize_path_segment(version))
}

pub fn prepare_for_update(
    data_dir: &Path,
    current_version: &str,
    next_version: &str,
    download_url: &str,
) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("create data dir {}: {e}", data_dir.display()))?;

    let target = detect_install_target().unwrap_or_else(|e| {
        tracing::warn!(
            target: "claudette::updater",
            error = %e,
            "boot probation could not detect self-contained install target"
        );
        InstallTarget {
            kind: InstallKind::Unsupported,
            target_path: PathBuf::new(),
            executable_path: std::env::current_exe().unwrap_or_default(),
            is_dir: false,
        }
    });

    let (backup_path, backup_error) = match create_backup(&target, current_version) {
        Ok(Some(path)) => (Some(path), None),
        Ok(None) => (None, None),
        Err(e) => {
            tracing::warn!(
                target: "claudette::updater",
                error = %e,
                "boot probation backup failed; rollback will degrade to a diagnostic report"
            );
            (None, Some(e))
        }
    };

    let probation = BootProbation {
        status: ProbationStatus::Pending,
        failed_version: next_version.to_string(),
        previous_version: current_version.to_string(),
        download_url: download_url.to_string(),
        install_kind: target.kind,
        target_path: target.target_path,
        executable_path: target.executable_path,
        backup_path,
        backup_error,
        attempts: 0,
        data_dir: data_dir.to_path_buf(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    write_probation(data_dir, &probation)
}

pub async fn acknowledge_boot(
    data_dir: &Path,
    state: &Arc<BootProbationState>,
) -> Result<(), String> {
    state.acknowledge();
    let path = sentinel_path(data_dir);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("clear boot probation {}: {e}", path.display())),
    }
}

pub fn start_monitor(app: AppHandle, state: Arc<BootProbationState>, data_dir: PathBuf) {
    let path = sentinel_path(&data_dir);
    let Ok(mut probation) = read_probation_path(&path) else {
        return;
    };
    if probation.status == ProbationStatus::RollbackFailed {
        return;
    }

    probation.attempts = probation.attempts.saturating_add(1);
    if let Err(e) = write_probation(&data_dir, &probation) {
        tracing::warn!(target: "claudette::updater", error = %e, "failed to update boot probation attempt count");
    }

    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = state.cancel.notified() => {}
            _ = tokio::time::sleep(PROBATION_TIMEOUT) => {
                if state.is_acknowledged() {
                    return;
                }
                handle_probation_timeout(&app, &data_dir).await;
            }
        }
    });
}

pub fn show_pending_report(app: &AppHandle, data_dir: &Path) {
    let path = report_path(data_dir);
    let Ok(report) = read_report_path(&path) else {
        return;
    };
    let _ = std::fs::remove_file(&path);

    let title = if report.restored {
        "Claudette update rolled back"
    } else {
        "Claudette update rollback failed"
    };
    let message = if report.restored {
        format!(
            "Update {} failed to start, so Claudette restored {}. Please report this at https://github.com/utensils/claudette/issues.",
            report.failed_version, report.previous_version
        )
    } else {
        format!(
            "Update {} failed to start, but Claudette could not restore {}. Download the previous release from {} and report this at https://github.com/utensils/claudette/issues.\n\n{}",
            report.failed_version,
            report.previous_version,
            report.download_url,
            report
                .error
                .unwrap_or_else(|| "Unknown rollback error".to_string())
        )
    };

    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

pub fn run_helper_from_args(args: &[String]) -> Option<Result<(), String>> {
    let idx = args
        .iter()
        .position(|arg| arg == "--boot-rollback-helper")?;
    let sentinel = args.get(idx + 1).map(PathBuf::from);
    let parent_pid = args.get(idx + 2).and_then(|raw| raw.parse::<u32>().ok());
    Some(match (sentinel, parent_pid) {
        (Some(sentinel), Some(parent_pid)) => run_helper(&sentinel, parent_pid),
        _ => Err("usage: --boot-rollback-helper <sentinel-path> <parent-pid>".to_string()),
    })
}

async fn handle_probation_timeout(app: &AppHandle, data_dir: &Path) {
    let path = sentinel_path(data_dir);
    let mut probation = match read_probation_path(&path) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(target: "claudette::updater", error = %e, "boot probation timed out but sentinel could not be read");
            return;
        }
    };

    if probation.backup_path.is_none() {
        let error = probation.backup_error.clone().unwrap_or_else(|| {
            "No previous install backup is available for this update target.".to_string()
        });
        probation.status = ProbationStatus::RollbackFailed;
        let _ = write_probation(data_dir, &probation);
        let _ = write_report(
            data_dir,
            &BootRollbackReport {
                failed_version: probation.failed_version,
                previous_version: probation.previous_version,
                download_url: probation.download_url,
                restored: false,
                error: Some(error),
            },
        );
        app.exit(1);
        return;
    }

    probation.status = ProbationStatus::RollbackInProgress;
    if let Err(e) = write_probation(data_dir, &probation) {
        tracing::warn!(target: "claudette::updater", error = %e, "failed to mark boot rollback in progress");
    }

    match spawn_rollback_helper(&path) {
        Ok(()) => app.exit(1),
        Err(e) => {
            tracing::error!(target: "claudette::updater", error = %e, "failed to spawn boot rollback helper");
            let mut failed = probation;
            failed.status = ProbationStatus::RollbackFailed;
            let _ = write_probation(data_dir, &failed);
            let _ = write_report(
                data_dir,
                &BootRollbackReport {
                    failed_version: failed.failed_version,
                    previous_version: failed.previous_version,
                    download_url: failed.download_url,
                    restored: false,
                    error: Some(e),
                },
            );
            app.exit(1);
        }
    }
}

fn run_helper(sentinel: &Path, parent_pid: u32) -> Result<(), String> {
    let probation = read_probation_path(sentinel)?;
    wait_for_parent_exit(parent_pid, Duration::from_secs(20));

    let result = restore_backup(&probation)
        .and_then(|_| relaunch(&probation))
        .map(|_| BootRollbackReport {
            failed_version: probation.failed_version.clone(),
            previous_version: probation.previous_version.clone(),
            download_url: probation.download_url.clone(),
            restored: true,
            error: None,
        })
        .unwrap_or_else(|e| BootRollbackReport {
            failed_version: probation.failed_version.clone(),
            previous_version: probation.previous_version.clone(),
            download_url: probation.download_url.clone(),
            restored: false,
            error: Some(e),
        });

    if result.restored {
        let _ = std::fs::remove_file(sentinel);
    } else {
        let mut failed = probation;
        failed.status = ProbationStatus::RollbackFailed;
        let _ = write_probation(&failed.data_dir.clone(), &failed);
    }
    write_report(&result_path_parent(sentinel), &result)
}

fn restore_backup(probation: &BootProbation) -> Result<(), String> {
    let backup = probation
        .backup_path
        .as_deref()
        .ok_or_else(|| "No previous install backup is available.".to_string())?;
    if !backup.exists() {
        return Err(format!("backup path is missing: {}", backup.display()));
    }

    if probation.target_path.exists() {
        remove_path(&probation.target_path).map_err(|e| {
            format!(
                "remove failed install {}: {e}",
                probation.target_path.display()
            )
        })?;
    }
    copy_path(backup, &probation.target_path)
        .map_err(|e| format!("restore {}: {e}", probation.target_path.display()))
}

fn relaunch(probation: &BootProbation) -> Result<(), String> {
    Command::new(&probation.executable_path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("relaunch {}: {e}", probation.executable_path.display()))
}

fn spawn_rollback_helper(sentinel: &Path) -> Result<(), String> {
    let helper = helper_executable(sentinel)?;
    Command::new(&helper)
        .arg("--boot-rollback-helper")
        .arg(sentinel)
        .arg(std::process::id().to_string())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("spawn rollback helper {}: {e}", helper.display()))
}

fn helper_executable(_sentinel: &Path) -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    #[cfg(windows)]
    {
        let helper = result_path_parent(_sentinel).join("boot-rollback-helper.exe");
        std::fs::copy(&current, &helper)
            .map_err(|e| format!("copy rollback helper {}: {e}", helper.display()))?;
        Ok(helper)
    }
    #[cfg(not(windows))]
    {
        Ok(current)
    }
}

fn wait_for_parent_exit(pid: u32, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline && is_pid_alive(pid) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    false
}

fn detect_install_target() -> Result<InstallTarget, String> {
    let executable_path = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    detect_install_target_from_exe(&executable_path)
}

fn detect_install_target_from_exe(executable_path: &Path) -> Result<InstallTarget, String> {
    #[cfg(target_os = "macos")]
    {
        let app = mac_app_root(executable_path)?;
        return Ok(InstallTarget {
            kind: InstallKind::MacApp,
            target_path: app,
            executable_path: executable_path.to_path_buf(),
            is_dir: true,
        });
    }

    #[cfg(target_os = "linux")]
    {
        let appimage = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .unwrap_or_else(|| executable_path.to_path_buf());
        return Ok(InstallTarget {
            kind: InstallKind::LinuxAppImage,
            target_path: appimage.clone(),
            executable_path: appimage,
            is_dir: false,
        });
    }

    #[cfg(windows)]
    {
        let dir = executable_path
            .parent()
            .ok_or_else(|| "current executable has no parent directory".to_string())?
            .to_path_buf();
        return Ok(InstallTarget {
            kind: InstallKind::WindowsInstallDir,
            target_path: dir,
            executable_path: executable_path.to_path_buf(),
            is_dir: true,
        });
    }

    #[allow(unreachable_code)]
    Err("unsupported updater target".to_string())
}

#[cfg(target_os = "macos")]
fn mac_app_root(executable_path: &Path) -> Result<PathBuf, String> {
    let mut cur = executable_path;
    while let Some(parent) = cur.parent() {
        if parent.extension().and_then(|s| s.to_str()) == Some("app") {
            return Ok(parent.to_path_buf());
        }
        cur = parent;
    }
    Err(format!(
        "could not find .app root for {}",
        executable_path.display()
    ))
}

fn create_backup(target: &InstallTarget, current_version: &str) -> Result<Option<PathBuf>, String> {
    if target.kind == InstallKind::Unsupported || target.target_path.as_os_str().is_empty() {
        return Ok(None);
    }
    let backup_root = updates_previous_dir(current_version);
    if backup_root.exists() {
        remove_path(&backup_root)
            .map_err(|e| format!("remove stale backup {}: {e}", backup_root.display()))?;
    }
    std::fs::create_dir_all(&backup_root)
        .map_err(|e| format!("create backup dir {}: {e}", backup_root.display()))?;

    let name = target
        .target_path
        .file_name()
        .ok_or_else(|| format!("target has no file name: {}", target.target_path.display()))?;
    let backup_path = backup_root.join(name);
    copy_path(&target.target_path, &backup_path)
        .map_err(|e| format!("copy backup {}: {e}", backup_path.display()))?;
    if target.is_dir && !backup_path.is_dir() {
        return Err(format!(
            "backup is not a directory: {}",
            backup_path.display()
        ));
    }
    Ok(Some(backup_path))
}

fn copy_path(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = std::fs::metadata(from)?;
    if meta.is_dir() {
        copy_dir_recursive(from, to)
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to)?;
        std::fs::set_permissions(to, meta.permissions())?;
        Ok(())
    }
}

fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let source = entry.path();
        let dest = to.join(entry.file_name());
        let meta = entry.metadata()?;
        if meta.is_dir() {
            copy_dir_recursive(&source, &dest)?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&source, &dest)?;
            std::fs::set_permissions(&dest, meta.permissions())?;
        }
    }
    let permissions = std::fs::metadata(from)?.permissions();
    std::fs::set_permissions(to, permissions)?;
    Ok(())
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn read_probation_path(path: &Path) -> Result<BootProbation, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read boot probation {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse boot probation {}: {e}", path.display()))
}

fn write_probation(data_dir: &Path, probation: &BootProbation) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("create data dir {}: {e}", data_dir.display()))?;
    write_json_atomically(&sentinel_path(data_dir), probation)
}

fn read_report_path(path: &Path) -> Result<BootRollbackReport, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("read boot rollback report {}: {e}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|e| format!("parse boot rollback report {}: {e}", path.display()))
}

fn write_report(data_dir: &Path, report: &BootRollbackReport) -> Result<(), String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("create data dir {}: {e}", data_dir.display()))?;
    write_json_atomically(&report_path(data_dir), report)
}

fn result_path_parent(sentinel: &Path) -> PathBuf {
    sentinel
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let body = serde_json::to_vec_pretty(value).map_err(|e| format!("serialize json: {e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    #[cfg(windows)]
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("replace {}: {e}", path.display()))?;
    }
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), path.display()))
}

fn sanitize_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use tempfile::tempdir;

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn sample_probation(data_dir: &Path, backup_path: Option<PathBuf>) -> BootProbation {
        BootProbation {
            status: ProbationStatus::Pending,
            failed_version: "0.25.0".to_string(),
            previous_version: "0.24.0".to_string(),
            download_url: "https://example.invalid/download".to_string(),
            install_kind: InstallKind::LinuxAppImage,
            target_path: data_dir.join("Claudette.AppImage"),
            executable_path: data_dir.join("Claudette.AppImage"),
            backup_path,
            backup_error: None,
            attempts: 0,
            data_dir: data_dir.to_path_buf(),
            created_at: "2026-05-10T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn writes_and_reads_probation_sentinel() {
        let tmp = tempdir().unwrap();
        let probation = sample_probation(tmp.path(), None);
        write_probation(tmp.path(), &probation).unwrap();

        let got = read_probation_path(&sentinel_path(tmp.path())).unwrap();
        assert_eq!(got.failed_version, "0.25.0");
        assert_eq!(got.previous_version, "0.24.0");
        assert_eq!(got.status, ProbationStatus::Pending);
    }

    #[tokio::test]
    async fn acknowledge_clears_sentinel_and_cancels_state() {
        let tmp = tempdir().unwrap();
        let state = Arc::new(BootProbationState::default());
        write_probation(tmp.path(), &sample_probation(tmp.path(), None)).unwrap();

        acknowledge_boot(tmp.path(), &state).await.unwrap();

        assert!(state.is_acknowledged());
        assert!(!sentinel_path(tmp.path()).exists());
    }

    #[test]
    fn restore_backup_replaces_failed_install() {
        let tmp = tempdir().unwrap();
        let failed = tmp.path().join("failed");
        let backup = tmp.path().join("backup");
        std::fs::create_dir_all(&failed).unwrap();
        std::fs::write(failed.join("app"), "broken").unwrap();
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(backup.join("app"), "restored").unwrap();

        let mut probation = sample_probation(tmp.path(), Some(backup));
        probation.target_path = failed.clone();
        probation.executable_path = failed.join("app");

        restore_backup(&probation).unwrap();

        assert_eq!(
            std::fs::read_to_string(failed.join("app")).unwrap(),
            "restored"
        );
    }

    #[test]
    fn restore_without_backup_fails_without_looping() {
        let tmp = tempdir().unwrap();
        let probation = sample_probation(tmp.path(), None);

        let err = restore_backup(&probation).unwrap_err();

        assert!(err.contains("No previous install backup"));
    }

    #[test]
    fn backup_helper_copies_files_and_directories() {
        let _guard = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        let tmp = tempdir().unwrap();
        let home = tmp.path().join("home");
        unsafe { std::env::set_var("CLAUDETTE_HOME", &home) };
        let source_dir = tmp.path().join("Source.app");
        std::fs::create_dir_all(source_dir.join("Contents/MacOS")).unwrap();
        std::fs::write(source_dir.join("Contents/MacOS/claudette-app"), "app").unwrap();
        let target = InstallTarget {
            kind: InstallKind::MacApp,
            target_path: source_dir,
            executable_path: tmp.path().join("Source.app/Contents/MacOS/claudette-app"),
            is_dir: true,
        };

        let backup = create_backup(&target, "test-version").unwrap().unwrap();

        assert!(backup.join("Contents/MacOS/claudette-app").exists());
        unsafe { std::env::remove_var("CLAUDETTE_HOME") };
    }

    #[test]
    fn rollback_failed_status_is_serialized_for_no_loop_state() {
        let tmp = tempdir().unwrap();
        let mut probation = sample_probation(tmp.path(), None);
        probation.status = ProbationStatus::RollbackFailed;
        write_probation(tmp.path(), &probation).unwrap();

        let raw = std::fs::read_to_string(sentinel_path(tmp.path())).unwrap();

        assert!(raw.contains("\"status\": \"rollback_failed\""));
    }

    #[test]
    fn writing_probation_replaces_existing_sentinel() {
        let tmp = tempdir().unwrap();
        let mut probation = sample_probation(tmp.path(), None);
        write_probation(tmp.path(), &probation).unwrap();

        probation.status = ProbationStatus::RollbackInProgress;
        probation.attempts = 2;
        write_probation(tmp.path(), &probation).unwrap();

        let got = read_probation_path(&sentinel_path(tmp.path())).unwrap();
        assert_eq!(got.status, ProbationStatus::RollbackInProgress);
        assert_eq!(got.attempts, 2);
    }
}
