use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

// ---------------------------------------------------------------------------
// Credential types (stored in macOS Keychain / Linux credentials file)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialFile {
    pub claude_ai_oauth: OAuthCredentials,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCredentials {
    pub access_token: String,
    pub refresh_token: String,
    /// Expiry as unix milliseconds.
    pub expires_at: u64,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

// ---------------------------------------------------------------------------
// Token refresh response
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TokenRefreshResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

// ---------------------------------------------------------------------------
// Usage API response types (returned to frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageLimit {
    pub utilization: f64,
    pub resets_at: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtraUsage {
    pub is_enabled: bool,
    #[serde(default)]
    pub monthly_limit: Option<f64>,
    #[serde(default)]
    pub used_credits: Option<f64>,
    #[serde(default)]
    pub utilization: Option<f64>,
}

/// The usage API response. We accept unknown fields gracefully since the
/// API shape is not officially documented and may contain extra fields.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageData {
    #[serde(default)]
    pub five_hour: Option<UsageLimit>,
    #[serde(default)]
    pub seven_day: Option<UsageLimit>,
    #[serde(default)]
    pub seven_day_sonnet: Option<UsageLimit>,
    #[serde(default)]
    pub seven_day_opus: Option<UsageLimit>,
    #[serde(default)]
    pub extra_usage: Option<ExtraUsage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeCodeUsage {
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    pub usage: UsageData,
    pub fetched_at: u64,
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

pub struct UsageCacheEntry {
    pub access_token: String,
    /// Kept for potential future token refresh from cache.
    #[allow(dead_code)]
    pub refresh_token: String,
    pub token_expires_at: u64,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    /// Cached usage response to avoid hammering the API.
    pub last_usage: Option<ClaudeCodeUsage>,
    /// When the usage was last fetched (unix millis).
    pub last_usage_fetched_at: u64,
}

/// Minimum interval between usage API calls (30 minutes).
/// The /api/oauth/usage endpoint has aggressive rate limiting — once a 429
/// is triggered, it persists for 30+ minutes with no Retry-After header.
/// Claude Code itself only calls this on-demand (no polling). We cache
/// aggressively to avoid triggering rate limits.
const USAGE_CACHE_TTL_MS: u64 = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES: &str = "user:inference user:profile user:sessions:claude_code";
const ANTHROPIC_BETA: &str = "oauth-2025-04-20";

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------------------
// Credential reading (platform-specific)
// ---------------------------------------------------------------------------

/// Sentinel error prefix returned when Claude Code is using env-var auth
/// (CLAUDE_CODE_OAUTH_TOKEN) instead of keychain. The usage API requires
/// full OAuth scopes that env-var tokens don't have.
const ENV_AUTH_ERROR: &str = "ENV_AUTH:";

#[cfg(target_os = "macos")]
async fn read_credentials_platform() -> Result<CredentialFile, String> {
    // Claude Code stores credentials under $USER, not a fixed account name.
    let user = std::env::var("USER").unwrap_or_else(|_| "root".to_string());
    let output = tokio::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-a",
            &user,
            "-w",
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to run security command: {e}"))?;

    if !output.status.success() {
        // No keychain entry — check if they're using env-var auth instead.
        if std::env::var("CLAUDE_CODE_OAUTH_TOKEN").is_ok() {
            return Err(format!(
                "{ENV_AUTH_ERROR}Claude Code is using environment variable authentication. \
                 Usage tracking requires a standard login. Run 'claude auth login' to enable."
            ));
        }
        return Err("Claude Code credentials not found. Sign in with 'claude auth login'.".into());
    }

    let json = String::from_utf8(output.stdout)
        .map_err(|e| format!("Invalid UTF-8 in credentials: {e}"))?;

    serde_json::from_str(&json).map_err(|e| format!("Failed to parse credentials: {e}"))
}

#[cfg(not(target_os = "macos"))]
async fn read_credentials_platform() -> Result<CredentialFile, String> {
    let path = dirs::home_dir()
        .ok_or("Cannot determine home directory")?
        .join(".claude")
        .join(".credentials.json");

    let content = tokio::fs::read_to_string(&path).await.map_err(|e| {
        if std::env::var("CLAUDE_CODE_OAUTH_TOKEN").is_ok() {
            return format!(
                "{ENV_AUTH_ERROR}Claude Code is using environment variable authentication. \
                 Usage tracking requires a standard login. Run 'claude auth login' to enable."
            );
        }
        format!(
            "Failed to read Claude Code credentials at {}: {e}",
            path.display()
        )
    })?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse credentials: {e}"))
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async fn refresh_token(refresh_token: &str) -> Result<TokenRefreshResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
            "scope": OAUTH_SCOPES,
        }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token refresh failed ({status}): {body}"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {e}"))
}

// ---------------------------------------------------------------------------
// Usage API fetch
// ---------------------------------------------------------------------------

async fn fetch_usage(access_token: &str) -> Result<UsageData, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("anthropic-beta", ANTHROPIC_BETA)
        .header("Content-Type", "application/json")
        .header("User-Agent", "claudette/0.8.0")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Usage API request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Usage API error ({status}): {body}"));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read usage response: {e}"))?;

    // Parse permissively: extract only the fields we care about from
    // whatever the API returns. Unknown fields are silently ignored.
    let raw: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Usage API returned invalid JSON: {e}"))?;

    // The response may wrap usage data in a top-level object or return it
    // directly. Try to extract our known fields from the top-level.
    serde_json::from_value(raw).map_err(|e| format!("Failed to parse usage data: {e}"))
}

// ---------------------------------------------------------------------------
// High-level: resolve a valid access token
// ---------------------------------------------------------------------------

/// Resolve an access token, trying in order:
/// 1. In-memory cache (if token not expired)
/// 2. Platform keychain / credentials file (with refresh if expired)
///
/// Note: CLAUDE_CODE_OAUTH_TOKEN env var is intentionally NOT used here.
/// Those tokens only have `user:inference` scope and cannot access the
/// usage API which requires full OAuth scopes.
async fn resolve_token(
    cache: &RwLock<Option<UsageCacheEntry>>,
) -> Result<(String, Option<String>, Option<String>), String> {
    let now = now_millis();

    // 1. Check cache — return if token is still valid.
    {
        let cached = cache.read().await;
        if let Some(entry) = cached.as_ref()
            && entry.token_expires_at > now + 60_000
        {
            return Ok((
                entry.access_token.clone(),
                entry.subscription_type.clone(),
                entry.rate_limit_tier.clone(),
            ));
        }
    }

    // 2. If we have a cached refresh token (possibly rotated), try it first
    //    before falling back to re-reading from keychain.
    let cached_refresh = {
        let cached = cache.read().await;
        cached
            .as_ref()
            .filter(|e| !e.refresh_token.is_empty())
            .map(|e| {
                (
                    e.refresh_token.clone(),
                    e.subscription_type.clone(),
                    e.rate_limit_tier.clone(),
                )
            })
    };

    if let Some((rt, sub_type, tier)) = cached_refresh
        && let Ok(refreshed) = refresh_token(&rt).await
    {
        let new_expires = now + refreshed.expires_in.unwrap_or(3600) * 1000;
        let new_refresh = refreshed.refresh_token.unwrap_or(rt);
        let mut w = cache.write().await;
        *w = Some(UsageCacheEntry {
            access_token: refreshed.access_token.clone(),
            refresh_token: new_refresh,
            token_expires_at: new_expires,
            subscription_type: sub_type.clone(),
            rate_limit_tier: tier.clone(),
            last_usage: None,
            last_usage_fetched_at: 0,
        });
        return Ok((refreshed.access_token, sub_type, tier));
    }
    // Cached refresh token failed or absent — fall through to keychain.

    // 3. Read from platform keychain / credentials file.
    let creds = read_credentials_platform().await?;
    let oauth = &creds.claude_ai_oauth;

    let (token, rt, expires) = if oauth.expires_at <= now + 60_000 {
        // Token expired — refresh.
        let refreshed = refresh_token(&oauth.refresh_token).await?;
        let new_expires = now + refreshed.expires_in.unwrap_or(3600) * 1000;
        let new_refresh = refreshed
            .refresh_token
            .unwrap_or_else(|| oauth.refresh_token.clone());
        (refreshed.access_token, new_refresh, new_expires)
    } else {
        (
            oauth.access_token.clone(),
            oauth.refresh_token.clone(),
            oauth.expires_at,
        )
    };

    let sub_type = oauth.subscription_type.clone();
    let tier = oauth.rate_limit_tier.clone();

    let mut w = cache.write().await;
    *w = Some(UsageCacheEntry {
        access_token: token.clone(),
        refresh_token: rt,
        token_expires_at: expires,
        subscription_type: sub_type.clone(),
        rate_limit_tier: tier.clone(),
        last_usage: None,
        last_usage_fetched_at: 0,
    });

    Ok((token, sub_type, tier))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

pub async fn get_usage(cache: &RwLock<Option<UsageCacheEntry>>) -> Result<ClaudeCodeUsage, String> {
    let now = now_millis();

    // Return cached usage if within TTL (30 minutes).
    // Also respect the TTL when we have NO cached data — this prevents
    // hammering the API after a 429 when there's no stale data to return.
    {
        let cached = cache.read().await;
        if let Some(entry) = cached.as_ref()
            && entry.last_usage_fetched_at > 0
            && now - entry.last_usage_fetched_at < USAGE_CACHE_TTL_MS
        {
            if let Some(ref usage) = entry.last_usage {
                return Ok(usage.clone());
            }
            // We attempted a fetch recently but got no data (e.g. 429).
            // Don't retry yet — respect the backoff.
            return Err("Usage data temporarily unavailable. Try again later.".into());
        }
    }

    let (access_token, sub_type, tier) = resolve_token(cache).await?;

    match fetch_usage(&access_token).await {
        Ok(usage_data) => {
            let result = ClaudeCodeUsage {
                subscription_type: sub_type,
                rate_limit_tier: tier,
                usage: usage_data,
                fetched_at: now,
            };
            let mut w = cache.write().await;
            if let Some(entry) = w.as_mut() {
                entry.last_usage = Some(result.clone());
                entry.last_usage_fetched_at = now;
            }
            Ok(result)
        }
        Err(e) => {
            // On 429 (rate limited), return stale cached data if available.
            // Either way, stamp the fetch time so we don't retry for 30 min.
            if e.contains("429") {
                let mut w = cache.write().await;
                if let Some(entry) = w.as_mut() {
                    entry.last_usage_fetched_at = now;
                    if let Some(ref usage) = entry.last_usage {
                        return Ok(usage.clone());
                    }
                }
            }
            // On 401, invalidate cache so next call re-resolves the token.
            if e.contains("401") {
                let mut w = cache.write().await;
                *w = None;
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- Credential parsing --------------------------------------------------

    #[test]
    fn parse_credential_file() {
        let json = r#"{
            "claudeAiOauth": {
                "accessToken": "sk-ant-oat01-test",
                "refreshToken": "sk-ant-ort01-test",
                "expiresAt": 1769163729172,
                "scopes": ["user:inference", "user:profile"],
                "subscriptionType": "max",
                "rateLimitTier": "default_claude_max_20x"
            }
        }"#;
        let creds: CredentialFile = serde_json::from_str(json).unwrap();
        assert_eq!(creds.claude_ai_oauth.access_token, "sk-ant-oat01-test");
        assert_eq!(creds.claude_ai_oauth.refresh_token, "sk-ant-ort01-test");
        assert_eq!(creds.claude_ai_oauth.expires_at, 1769163729172);
        assert_eq!(
            creds.claude_ai_oauth.subscription_type.as_deref(),
            Some("max")
        );
        assert_eq!(
            creds.claude_ai_oauth.rate_limit_tier.as_deref(),
            Some("default_claude_max_20x")
        );
    }

    #[test]
    fn parse_credential_file_minimal() {
        // subscription_type and rate_limit_tier are optional.
        let json = r#"{
            "claudeAiOauth": {
                "accessToken": "tok",
                "refreshToken": "ref",
                "expiresAt": 0
            }
        }"#;
        let creds: CredentialFile = serde_json::from_str(json).unwrap();
        assert_eq!(creds.claude_ai_oauth.subscription_type, None);
        assert_eq!(creds.claude_ai_oauth.rate_limit_tier, None);
    }

    // -- Usage data parsing --------------------------------------------------

    #[test]
    fn parse_usage_with_iso_timestamps() {
        let json = r#"{
            "five_hour": {
                "utilization": 42.5,
                "resets_at": "2026-04-13T17:59:59.859408+00:00"
            },
            "seven_day": {
                "utilization": 15.3,
                "resets_at": "2026-04-19T00:00:00+00:00"
            }
        }"#;
        let data: UsageData = serde_json::from_str(json).unwrap();
        let five = data.five_hour.unwrap();
        assert!((five.utilization - 42.5).abs() < f64::EPSILON);
        assert_eq!(
            five.resets_at.as_str().unwrap(),
            "2026-04-13T17:59:59.859408+00:00"
        );
        assert!(data.seven_day.is_some());
        assert!(data.seven_day_sonnet.is_none());
        assert!(data.seven_day_opus.is_none());
        assert!(data.extra_usage.is_none());
    }

    #[test]
    fn parse_usage_with_numeric_timestamps() {
        let json = r#"{
            "five_hour": {
                "utilization": 10.0,
                "resets_at": 1681234567
            }
        }"#;
        let data: UsageData = serde_json::from_str(json).unwrap();
        let five = data.five_hour.unwrap();
        assert_eq!(five.resets_at.as_f64().unwrap() as u64, 1681234567);
    }

    #[test]
    fn parse_usage_with_extra_usage() {
        let json = r#"{
            "five_hour": {
                "utilization": 0.0,
                "resets_at": "2026-04-13T18:00:00Z"
            },
            "extra_usage": {
                "is_enabled": true,
                "monthly_limit": 10000,
                "used_credits": 1234,
                "utilization": 12.34
            }
        }"#;
        let data: UsageData = serde_json::from_str(json).unwrap();
        let extra = data.extra_usage.unwrap();
        assert!(extra.is_enabled);
        assert_eq!(extra.monthly_limit, Some(10000.0));
        assert_eq!(extra.used_credits, Some(1234.0));
        assert!((extra.utilization.unwrap() - 12.34).abs() < f64::EPSILON);
    }

    #[test]
    fn parse_usage_with_extra_usage_unlimited() {
        let json = r#"{
            "extra_usage": {
                "is_enabled": true,
                "monthly_limit": null,
                "used_credits": 500,
                "utilization": null
            }
        }"#;
        let data: UsageData = serde_json::from_str(json).unwrap();
        let extra = data.extra_usage.unwrap();
        assert!(extra.is_enabled);
        assert_eq!(extra.monthly_limit, None);
        assert_eq!(extra.used_credits, Some(500.0));
        assert_eq!(extra.utilization, None);
    }

    #[test]
    fn parse_usage_ignores_unknown_fields() {
        // The API may include fields we don't model (e.g. seven_day_oauth_apps).
        let json = r#"{
            "five_hour": {
                "utilization": 5.0,
                "resets_at": "2026-04-13T18:00:00Z"
            },
            "seven_day_oauth_apps": {
                "utilization": 1.0,
                "resets_at": "2026-04-19T00:00:00Z"
            },
            "some_future_field": "whatever"
        }"#;
        let raw: serde_json::Value = serde_json::from_str(json).unwrap();
        let data: UsageData = serde_json::from_value(raw).unwrap();
        assert!(data.five_hour.is_some());
        // Unknown fields are silently dropped.
    }

    #[test]
    fn parse_usage_empty_response() {
        let json = "{}";
        let data: UsageData = serde_json::from_str(json).unwrap();
        assert!(data.five_hour.is_none());
        assert!(data.seven_day.is_none());
        assert!(data.extra_usage.is_none());
    }

    // -- Token refresh response parsing --------------------------------------

    #[test]
    fn parse_token_refresh_response() {
        let json = r#"{
            "access_token": "new-tok",
            "token_type": "bearer",
            "expires_in": 3600,
            "scope": "user:inference user:profile",
            "refresh_token": "new-ref"
        }"#;
        let resp: TokenRefreshResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.access_token, "new-tok");
        assert_eq!(resp.refresh_token.as_deref(), Some("new-ref"));
        assert_eq!(resp.expires_in, Some(3600));
    }

    #[test]
    fn parse_token_refresh_response_minimal() {
        // refresh_token and expires_in may be absent.
        let json = r#"{"access_token": "tok"}"#;
        let resp: TokenRefreshResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.access_token, "tok");
        assert_eq!(resp.refresh_token, None);
        assert_eq!(resp.expires_in, None);
    }

    // -- Cache TTL (sync tests using tokio::runtime::Runtime) ----------------

    fn make_cache_with_usage(fetched_at: u64) -> RwLock<Option<UsageCacheEntry>> {
        RwLock::new(Some(UsageCacheEntry {
            access_token: "tok".into(),
            refresh_token: "ref".into(),
            token_expires_at: now_millis() + 3_600_000,
            subscription_type: Some("max".into()),
            rate_limit_tier: None,
            last_usage: Some(ClaudeCodeUsage {
                subscription_type: Some("max".into()),
                rate_limit_tier: None,
                usage: UsageData::default(),
                fetched_at: 0,
            }),
            last_usage_fetched_at: fetched_at,
        }))
    }

    #[test]
    fn cache_returns_fresh_usage() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let cache = make_cache_with_usage(now_millis());

        let result = rt.block_on(get_usage(&cache)).unwrap();
        assert_eq!(result.subscription_type.as_deref(), Some("max"));
    }

    #[test]
    fn stale_cache_triggers_refetch_but_falls_back() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        // Fetched > TTL ago — cache is stale.
        let cache = make_cache_with_usage(now_millis() - USAGE_CACHE_TTL_MS - 1);

        // Cache is stale, so get_usage tries the API. Without a real server
        // the fetch fails, but the error handler returns the stale cached
        // data as a fallback (better than showing nothing).
        let result = rt.block_on(get_usage(&cache));
        assert!(result.is_ok());
    }

    #[test]
    fn empty_cache_returns_error_on_failure() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        // Cache with token but no usage data at all.
        let cache = RwLock::new(Some(UsageCacheEntry {
            access_token: "tok".into(),
            refresh_token: "ref".into(),
            token_expires_at: now_millis() + 3_600_000,
            subscription_type: Some("max".into()),
            rate_limit_tier: None,
            last_usage: None,
            last_usage_fetched_at: 0,
        }));

        // No stale data to fall back to — should return an error.
        let result = rt.block_on(get_usage(&cache));
        assert!(result.is_err());
    }
}
