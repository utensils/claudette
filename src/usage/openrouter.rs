//! OpenRouter credit-balance source.
//!
//! OpenRouter exposes `GET https://openrouter.ai/api/v1/credits`
//! which returns `{ data: { total_credits, total_usage } }`. We
//! surface a single `openrouter_credits` bucket and let
//! [`local_aggregate`](super::local_aggregate) add the token-totals
//! buckets on top.
//!
//! Detection: a `CustomOpenAi` backend whose `base_url` resolves to a
//! host under `openrouter.ai` routes here. Other OpenAI-compatible
//! cards fall through to local-aggregate only.

use serde::Deserialize;

use super::UsageBucket;

const OPENROUTER_CREDITS_URL: &str = "https://openrouter.ai/api/v1/credits";

/// Shared `reqwest::Client` reused across every credit-balance fetch
/// so the recurring poll doesn't pay TLS/handshake costs on each tick.
/// Mirrors the static client pattern in
/// [`anthropic_oauth::http_client`](super::anthropic_oauth).
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, Clone, Deserialize)]
struct CreditsResponse {
    data: CreditsData,
}

#[derive(Debug, Clone, Deserialize)]
struct CreditsData {
    total_credits: f64,
    total_usage: f64,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterCredits {
    pub total_credits: f64,
    pub used_credits: f64,
    pub remaining_credits: f64,
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

/// Fetch the OpenRouter credit balance.
pub async fn fetch_credits(api_key: &str) -> Result<OpenRouterCredits, String> {
    let resp = http_client()
        .get(OPENROUTER_CREDITS_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("OpenRouter credits fetch failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("OpenRouter API error: {}", resp.status()));
    }

    let parsed: CreditsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse OpenRouter response: {e}"))?;

    Ok(credits_from(&parsed.data))
}

/// Fetch the OpenRouter credit balance and convert it into a single
/// `openrouter_credits` bucket. Returns `Err` only on network / API
/// errors — the caller decides whether to still emit a snapshot from
/// local aggregates alone.
pub async fn fetch_credit_bucket(api_key: &str) -> Result<Option<UsageBucket>, String> {
    fetch_credits(api_key)
        .await
        .map(|credits| Some(credit_bucket_from(&credits)))
}

fn credits_from(data: &CreditsData) -> OpenRouterCredits {
    let remaining = (data.total_credits - data.total_usage).max(0.0);
    OpenRouterCredits {
        total_credits: data.total_credits,
        used_credits: data.total_usage,
        remaining_credits: remaining,
    }
}

pub fn credit_bucket_from(credits: &OpenRouterCredits) -> UsageBucket {
    let utilization = if credits.total_credits > 0.0 {
        (credits.used_credits / credits.total_credits).clamp(0.0, 1.0) as f32
    } else {
        0.0
    };
    UsageBucket {
        key: String::from("openrouter_credits"),
        label: String::from("OpenRouter balance"),
        utilization,
        primary_text: format!("${:.2} remaining", credits.remaining_credits),
        secondary_text: Some(format!("${:.2} used", credits.used_credits)),
        is_bounded: true,
        exhausted: credits.remaining_credits <= 0.0,
    }
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
        let data = OpenRouterCredits {
            total_credits: 5.0,
            used_credits: 2.41,
            remaining_credits: 2.59,
        };
        let bucket = credit_bucket_from(&data);
        assert_eq!(bucket.key, "openrouter_credits");
        assert!(bucket.primary_text.contains("$2.59"));
        assert!(bucket.secondary_text.unwrap().contains("$2.41"));
        assert!(!bucket.exhausted);
        assert!((bucket.utilization - 0.482).abs() < 0.001);
    }

    #[test]
    fn credits_from_clamps_remaining_at_zero() {
        let credits = credits_from(&CreditsData {
            total_credits: 5.0,
            total_usage: 7.0,
        });
        assert_eq!(credits.remaining_credits, 0.0);
    }

    #[test]
    fn credit_bucket_exhausted_when_usage_meets_credits() {
        let data = OpenRouterCredits {
            total_credits: 5.0,
            used_credits: 5.0,
            remaining_credits: 0.0,
        };
        let bucket = credit_bucket_from(&data);
        assert!(bucket.exhausted);
        assert!((bucket.utilization - 1.0).abs() < 1e-6);
    }

    #[test]
    fn credit_bucket_exhausted_when_total_credits_are_zero() {
        let data = OpenRouterCredits {
            total_credits: 0.0,
            used_credits: 0.0,
            remaining_credits: 0.0,
        };
        let bucket = credit_bucket_from(&data);
        assert!(bucket.exhausted);
        assert_eq!(bucket.utilization, 0.0);
    }
}
