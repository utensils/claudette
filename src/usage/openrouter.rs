//! OpenRouter credit-balance source.
//!
//! OpenRouter exposes `GET https://openrouter.ai/api/v1/auth/key`
//! which returns `{ data: { limit, usage, is_free_tier, label, ... } }`.
//! `limit` may be `null` for unlimited tiers; `usage` is dollars spent
//! against the key. We surface a single `openrouter_credits` bucket
//! and let [`local_aggregate`](super::local_aggregate) add the
//! token-totals buckets on top.
//!
//! Detection: a `CustomOpenAi` backend whose `base_url` resolves to a
//! host under `openrouter.ai` routes here. Other OpenAI-compatible
//! cards fall through to local-aggregate only.

use serde::Deserialize;

use super::UsageBucket;

const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/auth/key";

#[derive(Debug, Clone, Deserialize)]
struct AuthKeyResponse {
    data: AuthKeyData,
}

#[derive(Debug, Clone, Deserialize)]
struct AuthKeyData {
    /// Dollars used against this key so far.
    #[serde(default)]
    usage: f64,
    /// Spending cap in dollars, or `None` for unlimited tiers.
    #[serde(default)]
    limit: Option<f64>,
    /// `true` for free-tier keys with daily request caps rather than $.
    #[serde(default)]
    is_free_tier: bool,
}

/// Detect whether a backend's `base_url` points at OpenRouter. Matches
/// any `*.openrouter.ai` host so a custom proxy with that hostname is
/// still treated as an OpenRouter backend. URLs without an explicit
/// scheme (or with a malformed URL) return `false`.
pub fn is_openrouter_base_url(base_url: Option<&str>) -> bool {
    let Some(url) = base_url else {
        return false;
    };
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    parsed
        .host_str()
        .map(|h| {
            let h = h.to_ascii_lowercase();
            h == "openrouter.ai" || h.ends_with(".openrouter.ai")
        })
        .unwrap_or(false)
}

/// Fetch the OpenRouter credit balance and convert it into a single
/// `openrouter_credits` bucket. Returns `Ok(None)` for free-tier keys
/// (no dollar limit to surface) and `Err` only on network / API errors
/// — the caller decides whether to still emit a snapshot from local
/// aggregates alone.
pub async fn fetch_credit_bucket(api_key: &str) -> Result<Option<UsageBucket>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(OPENROUTER_KEY_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("OpenRouter key fetch failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("OpenRouter API error: {}", resp.status()));
    }

    let parsed: AuthKeyResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse OpenRouter response: {e}"))?;

    Ok(credit_bucket_from(&parsed.data))
}

fn credit_bucket_from(data: &AuthKeyData) -> Option<UsageBucket> {
    if data.is_free_tier {
        return None;
    }
    let limit = data.limit?;
    if limit <= 0.0 {
        return None;
    }
    let utilization = (data.usage / limit).clamp(0.0, 1.0) as f32;
    Some(UsageBucket {
        key: String::from("openrouter_credits"),
        label: String::from("Credits"),
        utilization,
        primary_text: format!("${:.2} / ${:.2}", data.usage, limit),
        secondary_text: Some(format!("{}% used", (utilization * 100.0).floor() as i64)),
        is_bounded: true,
        exhausted: data.usage >= limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_openrouter_root_url() {
        assert!(is_openrouter_base_url(Some("https://openrouter.ai/api/v1")));
    }

    #[test]
    fn detects_openrouter_subdomain() {
        assert!(is_openrouter_base_url(Some(
            "https://us.openrouter.ai/api/v1"
        )));
    }

    #[test]
    fn rejects_unrelated_hosts() {
        assert!(!is_openrouter_base_url(Some("https://api.openai.com")));
        assert!(!is_openrouter_base_url(Some("http://localhost:11434/v1")));
        assert!(!is_openrouter_base_url(Some("not a url")));
        assert!(!is_openrouter_base_url(None));
    }

    #[test]
    fn credit_bucket_with_limit() {
        let data = AuthKeyData {
            usage: 2.41,
            limit: Some(5.0),
            is_free_tier: false,
        };
        let bucket = credit_bucket_from(&data).unwrap();
        assert_eq!(bucket.key, "openrouter_credits");
        assert!(bucket.primary_text.contains("$2.41"));
        assert!(bucket.primary_text.contains("$5.00"));
        assert!(!bucket.exhausted);
        assert!((bucket.utilization - 0.482).abs() < 0.001);
    }

    #[test]
    fn credit_bucket_free_tier_returns_none() {
        let data = AuthKeyData {
            usage: 0.0,
            limit: None,
            is_free_tier: true,
        };
        assert!(credit_bucket_from(&data).is_none());
    }

    #[test]
    fn credit_bucket_unlimited_tier_returns_none() {
        // Paid but unlimited — no dollar bucket to surface; the local
        // aggregate carries the spend visualization on its own.
        let data = AuthKeyData {
            usage: 12.34,
            limit: None,
            is_free_tier: false,
        };
        assert!(credit_bucket_from(&data).is_none());
    }

    #[test]
    fn credit_bucket_exhausted_when_usage_meets_limit() {
        let data = AuthKeyData {
            usage: 5.0,
            limit: Some(5.0),
            is_free_tier: false,
        };
        let bucket = credit_bucket_from(&data).unwrap();
        assert!(bucket.exhausted);
        assert!((bucket.utilization - 1.0).abs() < 1e-6);
    }
}
