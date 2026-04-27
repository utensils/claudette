use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::state::AppState;

const STABLE_URL: &str =
    "https://github.com/utensils/claudette/releases/latest/download/latest.json";
const NIGHTLY_URL: &str =
    "https://github.com/utensils/claudette/releases/download/nightly/latest.json";

const GITHUB_RELEASES_API: &str =
    "https://api.github.com/repos/utensils/claudette/releases?per_page=10";
const NIGHTLY_CANDIDATE_LIMIT: usize = 3;
const USER_AGENT: &str = concat!("claudette-updater/", env!("CARGO_PKG_VERSION"));
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);

/// Subset of [`tauri_plugin_updater::Update`] that we expose across the IPC boundary.
#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

fn endpoint_for(channel: &str) -> &'static str {
    match channel {
        "stable" => STABLE_URL,
        "nightly" => NIGHTLY_URL,
        other => {
            eprintln!("[updater] Unknown channel {other:?}, falling back to stable");
            STABLE_URL
        }
    }
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Subset of the GitHub Releases API payload we filter on.
#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
}

/// Parse a GitHub Releases API response and return the top `limit` candidate
/// `latest.json` URLs for the nightly channel, newest first. Pure function so
/// the filtering/sorting logic is unit-testable without HTTP.
fn nightly_candidate_urls_from_json(body: &str, limit: usize) -> Vec<Url> {
    if limit == 0 {
        return Vec::new();
    }
    let releases: Vec<GhRelease> = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut filtered: Vec<GhRelease> = releases
        .into_iter()
        .filter(|r| {
            !r.draft
                && r.prerelease
                && r.tag_name != "nightly-staging"
                && (r.tag_name == "nightly" || r.tag_name.starts_with("nightly-"))
        })
        .collect();

    // Newest first. ISO-8601 Z-suffixed timestamps sort correctly as strings.
    // Releases with no published_at sort last (treated as oldest).
    filtered.sort_by(|a, b| b.published_at.cmp(&a.published_at));

    let mut urls: Vec<Url> = Vec::new();
    for r in filtered {
        let raw = format!(
            "https://github.com/utensils/claudette/releases/download/{}/latest.json",
            r.tag_name
        );
        if let Ok(url) = Url::parse(&raw)
            && !urls.contains(&url)
        {
            urls.push(url);
            if urls.len() >= limit {
                break;
            }
        }
    }
    urls
}

/// Discover nightly `latest.json` candidate URLs by querying the GitHub
/// Releases API. Always returns a (possibly empty) vec; transport, HTTP,
/// or parse failures are logged and downgrade to "no candidates," letting
/// the caller fall back to the static [`NIGHTLY_URL`].
async fn discover_nightly_endpoints() -> Vec<Url> {
    let resp = match http_client()
        .get(GITHUB_RELEASES_API)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .timeout(DISCOVERY_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!(
                "[updater] Nightly discovery request failed: {e}; falling back to static URL"
            );
            return Vec::new();
        }
    };

    let status = resp.status();
    if !status.is_success() {
        eprintln!("[updater] Nightly discovery returned HTTP {status}; falling back to static URL");
        return Vec::new();
    }

    let body = match resp.text().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!(
                "[updater] Nightly discovery body read failed: {e}; falling back to static URL"
            );
            return Vec::new();
        }
    };

    nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT)
}

/// Build the ordered endpoint list to feed to the Tauri updater plugin. The
/// plugin tries each in order and stops at the first one that fetches +
/// parses, so a broken `latest.json` from the most recent nightly silently
/// fails over to the previous one.
async fn endpoints_for(channel: &str) -> Result<Vec<Url>, String> {
    if channel == "nightly" {
        let mut endpoints = discover_nightly_endpoints().await;
        let static_fallback: Url = NIGHTLY_URL
            .parse()
            .map_err(|e: url::ParseError| e.to_string())?;
        if !endpoints.contains(&static_fallback) {
            endpoints.push(static_fallback);
        }
        return Ok(endpoints);
    }

    let url: Url = endpoint_for(channel)
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    Ok(vec![url])
}

fn release_download_tag(url: &Url) -> Option<&str> {
    if url.host_str() != Some("github.com") {
        return None;
    }

    let mut segments = url.path_segments()?;
    while let Some(segment) = segments.next() {
        if segment == "releases" && segments.next() == Some("download") {
            return segments.next();
        }
    }
    None
}

fn is_transient_release_tag(tag: &str) -> bool {
    tag.starts_with("untagged-") || tag.contains("staging")
}

fn string_contains_transient_release_url(value: &str) -> bool {
    Url::parse(value)
        .ok()
        .and_then(|url| release_download_tag(&url).map(str::to_owned))
        .is_some_and(|tag| is_transient_release_tag(&tag))
}

fn manifest_contains_transient_release_url(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(s) => string_contains_transient_release_url(s),
        serde_json::Value::Array(items) => {
            items.iter().any(manifest_contains_transient_release_url)
        }
        serde_json::Value::Object(map) => map.values().any(manifest_contains_transient_release_url),
        _ => false,
    }
}

fn update_contains_transient_release_url(update: &tauri_plugin_updater::Update) -> bool {
    release_download_tag(&update.download_url).is_some_and(is_transient_release_tag)
        || manifest_contains_transient_release_url(&update.raw_json)
}

/// Classifies an updater error: `Ok(())` means "downgrade to no update
/// available", `Err(...)` is a real transport/parse failure that should
/// bubble up to the UI.
///
/// `Error::ReleaseNotFound` covers two situations:
///   1. HTTP 404 on `latest.json` — the manifest does not exist (or is hidden
///      behind a draft release, as happens during an in-progress nightly build).
///   2. Any other non-success HTTP status (e.g. 5xx) where the response was
///      received but parsed nothing — the upstream plugin maps these to the
///      same variant.
///
/// Both are benign from the user's standpoint: their currently-installed build
/// is still working; the catalog is just temporarily uninformative. Surfacing a
/// red error banner for either is more alarming than the situation warrants.
/// True transport failures (DNS, TLS, connect) reach us as `Reqwest`/`Network`
/// variants and continue to error.
fn classify_check_error(err: tauri_plugin_updater::Error) -> Result<(), String> {
    match err {
        tauri_plugin_updater::Error::ReleaseNotFound => Ok(()),
        other => Err(other.to_string()),
    }
}

/// Check the configured channel's release feed for an update.
///
/// On success, the resulting [`tauri_plugin_updater::Update`] is stashed in
/// [`AppState::pending_update`] so that [`install_pending_update`] can hand it
/// off to the platform installer. The serializable [`UpdateInfo`] is returned
/// to JS so the UI can render the version banner.
#[tauri::command]
pub async fn check_for_updates_with_channel(
    app: AppHandle,
    state: State<'_, AppState>,
    channel: String,
) -> Result<Option<UpdateInfo>, String> {
    let endpoints = endpoints_for(&channel).await?;
    let mut update = None;
    let mut last_error = None;

    for endpoint in endpoints {
        let result = app
            .updater_builder()
            .endpoints(vec![endpoint.clone()])
            .map_err(|e| e.to_string())?
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await;

        match result {
            Ok(Some(candidate)) => {
                if update_contains_transient_release_url(&candidate) {
                    eprintln!(
                        "[updater] Ignoring update manifest from {endpoint}: \
                         asset URL points at staging/temporary release"
                    );
                    continue;
                }
                update = Some(candidate);
                last_error = None;
                break;
            }
            Ok(None) => {
                last_error = None;
                break;
            }
            Err(e) => match classify_check_error(e) {
                Ok(()) => {
                    eprintln!(
                        "[updater] Release manifest unavailable at {endpoint} for channel \
                         {channel:?}; trying next endpoint"
                    );
                }
                Err(msg) => {
                    eprintln!("[updater] Update check failed at {endpoint}: {msg}");
                    last_error = Some(msg);
                }
            },
        }
    }

    if update.is_none()
        && let Some(msg) = last_error
    {
        return Err(msg);
    }

    let mut slot = state.pending_update.lock().await;
    match update {
        Some(u) => {
            let info = UpdateInfo {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                body: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
            };
            *slot = Some(u);
            Ok(Some(info))
        }
        None => {
            *slot = None;
            Ok(None)
        }
    }
}

/// Download and install the pending update, then restart the app.
///
/// Emits `updater://progress` (u32, 0–100) as bytes arrive so the UI can drive
/// its progress bar. Returns an error if no update is pending.
#[tauri::command]
pub async fn install_pending_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let update = state
        .pending_update
        .lock()
        .await
        .take()
        .ok_or_else(|| "No pending update".to_string())?;

    let app_for_cb = app.clone();
    let mut total: u64 = 0;
    let mut downloaded: u64 = 0;

    update
        .download_and_install(
            move |chunk_len, content_len| {
                if let Some(c) = content_len {
                    total = c;
                }
                downloaded += chunk_len as u64;
                let pct = downloaded
                    .checked_mul(100)
                    .and_then(|v| v.checked_div(total))
                    .unwrap_or(0)
                    .min(100) as u32;
                let _ = app_for_cb.emit("updater://progress", pct);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // `AppHandle::restart` returns `!` (it ends the process), so it satisfies
    // the `Result<(), String>` signature without an explicit `Ok(())`.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_not_found_is_treated_as_no_update() {
        let result = classify_check_error(tauri_plugin_updater::Error::ReleaseNotFound);
        assert!(matches!(result, Ok(())));
    }

    #[test]
    fn other_errors_bubble_up_as_strings() {
        // Pick any non-ReleaseNotFound variant the upstream enum exposes.
        let err = tauri_plugin_updater::Error::EmptyEndpoints;
        let expected = err.to_string();
        match classify_check_error(err) {
            Err(msg) => assert_eq!(msg, expected),
            Ok(_) => panic!("EmptyEndpoints should not be downgraded"),
        }
    }

    #[test]
    fn endpoint_for_known_channels() {
        assert_eq!(endpoint_for("stable"), STABLE_URL);
        assert_eq!(endpoint_for("nightly"), NIGHTLY_URL);
        // Unknown channels fall back to stable (and log a warning).
        assert_eq!(endpoint_for("garbage"), STABLE_URL);
    }

    fn release_json(
        tag: &str,
        draft: bool,
        prerelease: bool,
        published_at: Option<&str>,
    ) -> String {
        let pa = match published_at {
            Some(s) => format!("\"{s}\""),
            None => "null".to_string(),
        };
        format!(
            "{{\"tag_name\":\"{tag}\",\"draft\":{draft},\"prerelease\":{prerelease},\"published_at\":{pa}}}"
        )
    }

    fn url(tag: &str) -> Url {
        Url::parse(&format!(
            "https://github.com/utensils/claudette/releases/download/{tag}/latest.json"
        ))
        .unwrap()
    }

    #[test]
    fn extracts_release_download_tag_from_github_url() {
        let url = Url::parse(
            "https://github.com/utensils/claudette/releases/download/nightly/latest.json",
        )
        .unwrap();
        assert_eq!(release_download_tag(&url), Some("nightly"));
    }

    #[test]
    fn detects_transient_release_tags() {
        assert!(is_transient_release_tag("nightly-staging"));
        assert!(is_transient_release_tag("v0.20.0-staging-123"));
        assert!(is_transient_release_tag("untagged-dc659d313a6f82718f77"));
        assert!(!is_transient_release_tag("nightly"));
        assert!(!is_transient_release_tag("v0.20.0"));
    }

    #[test]
    fn detects_transient_release_urls_anywhere_in_manifest() {
        let manifest = serde_json::json!({
            "version": "0.20.0",
            "platforms": {
                "darwin-aarch64": {
                    "signature": "sig",
                    "url": "https://github.com/utensils/claudette/releases/download/nightly-staging/Claudette.app.tar.gz"
                }
            }
        });
        assert!(manifest_contains_transient_release_url(&manifest));
    }

    #[test]
    fn accepts_public_release_urls_in_manifest() {
        let manifest = serde_json::json!({
            "version": "0.20.0",
            "platforms": {
                "darwin-aarch64": {
                    "signature": "sig",
                    "url": "https://github.com/utensils/claudette/releases/download/nightly/Claudette.app.tar.gz"
                }
            }
        });
        assert!(!manifest_contains_transient_release_url(&manifest));
    }

    #[test]
    fn parses_and_filters_top_three_nightlies() {
        let body = format!(
            "[{},{},{},{},{}]",
            release_json("v0.19.0", false, false, Some("2026-04-25T00:00:00Z")),
            release_json("nightly-staging", true, true, Some("2026-04-26T18:00:00Z")),
            release_json("nightly", false, true, Some("2026-04-26T15:00:00Z")),
            release_json(
                "nightly-2026-04-25",
                false,
                true,
                Some("2026-04-25T12:00:00Z")
            ),
            release_json(
                "nightly-2026-04-24",
                false,
                true,
                Some("2026-04-24T12:00:00Z")
            ),
        );
        let got = nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT);
        assert_eq!(
            got,
            vec![
                url("nightly"),
                url("nightly-2026-04-25"),
                url("nightly-2026-04-24"),
            ]
        );
    }

    #[test]
    fn excludes_drafts() {
        let body = format!(
            "[{}]",
            release_json("nightly", true, true, Some("2026-04-26T15:00:00Z"))
        );
        assert!(nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT).is_empty());
    }

    #[test]
    fn excludes_nightly_staging_even_when_published() {
        let body = format!(
            "[{}]",
            release_json("nightly-staging", false, true, Some("2026-04-26T15:00:00Z"))
        );
        assert!(nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT).is_empty());
    }

    #[test]
    fn excludes_non_prerelease() {
        let body = format!(
            "[{}]",
            release_json("nightly", false, false, Some("2026-04-26T15:00:00Z"))
        );
        assert!(nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT).is_empty());
    }

    #[test]
    fn malformed_json_returns_empty() {
        assert!(nightly_candidate_urls_from_json("not json", NIGHTLY_CANDIDATE_LIMIT).is_empty());
    }

    #[test]
    fn limit_zero_returns_empty() {
        let body = format!(
            "[{}]",
            release_json("nightly", false, true, Some("2026-04-26T15:00:00Z"))
        );
        assert!(nightly_candidate_urls_from_json(&body, 0).is_empty());
    }

    #[test]
    fn respects_limit() {
        let body = format!(
            "[{},{},{}]",
            release_json("nightly", false, true, Some("2026-04-26T15:00:00Z")),
            release_json(
                "nightly-2026-04-25",
                false,
                true,
                Some("2026-04-25T12:00:00Z")
            ),
            release_json(
                "nightly-2026-04-24",
                false,
                true,
                Some("2026-04-24T12:00:00Z")
            ),
        );
        let got = nightly_candidate_urls_from_json(&body, 1);
        assert_eq!(got, vec![url("nightly")]);
    }

    #[test]
    fn missing_published_at_sorts_last() {
        let body = format!(
            "[{},{}]",
            release_json("nightly-undated", false, true, None),
            release_json("nightly", false, true, Some("2026-04-26T15:00:00Z")),
        );
        let got = nightly_candidate_urls_from_json(&body, NIGHTLY_CANDIDATE_LIMIT);
        assert_eq!(got, vec![url("nightly"), url("nightly-undated")]);
    }
}
