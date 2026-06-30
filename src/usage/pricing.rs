//! Model pricing table used by the OpenAI / OpenRouter cost path.
//!
//! Used by [`local_aggregate`](super::local_aggregate) when the
//! `chat_messages.cost_usd` column wasn't populated by the harness
//! (Claude Code populates it; the Codex / Pi harnesses don't yet).
//! Costs are best-effort — the lookup falls back to `None` for unknown
//! model ids and the snapshot drops the dollar figure rather than
//! showing a misleading one.

/// $/Mtok rates for a single model. `prompt` covers regular input
/// tokens; `completion` covers output tokens. Cache reads / writes
/// aren't broken out separately — the meter's [`ModelPricing::cost`]
/// estimate ignores `cache_*_tokens` entirely, on the assumption that
/// the dollar figure here is already a ballpark and cache deltas are
/// a small fraction of the absolute number.
#[derive(Debug, Clone, Copy)]
pub struct ModelPricing {
    pub prompt_per_mtok_usd: f64,
    pub completion_per_mtok_usd: f64,
}

impl ModelPricing {
    /// Estimated dollar cost for an (input, output) token pair.
    pub fn cost(&self, input_tokens: i64, output_tokens: i64) -> f64 {
        let prompt = (input_tokens.max(0) as f64) / 1_000_000.0 * self.prompt_per_mtok_usd;
        let completion = (output_tokens.max(0) as f64) / 1_000_000.0 * self.completion_per_mtok_usd;
        prompt + completion
    }
}

/// Lookup pricing for a model id. Returns `None` for unknown models —
/// callers should drop the dollar figure rather than guess. Matching is
/// case-insensitive and tolerant of common id variants (`gpt-5.4`,
/// `gpt-5.4-2026-04-01`, `openai/gpt-5.4`, …).
pub fn lookup(model_id: &str) -> Option<ModelPricing> {
    let normalized = model_id.to_ascii_lowercase();
    let normalized = normalized.rsplit('/').next().unwrap_or(&normalized);

    for (prefix, pricing) in PRICING_TABLE {
        if normalized.starts_with(prefix) {
            return Some(*pricing);
        }
    }
    None
}

/// Prefix-keyed pricing table. Order matters — longer prefixes first so
/// `gpt-5.4-mini` doesn't accidentally match the `gpt-5.4` entry. The
/// table covers the common defaults users actually hit; rare models
/// fall back to "no cost displayed" rather than a wrong number.
const PRICING_TABLE: &[(&str, ModelPricing)] = &[
    // -- OpenAI ---------------------------------------------------------
    (
        "gpt-5.4-mini",
        ModelPricing {
            prompt_per_mtok_usd: 0.25,
            completion_per_mtok_usd: 2.00,
        },
    ),
    (
        "gpt-5.4",
        ModelPricing {
            prompt_per_mtok_usd: 1.25,
            completion_per_mtok_usd: 10.00,
        },
    ),
    (
        "gpt-5.3-codex",
        ModelPricing {
            prompt_per_mtok_usd: 1.25,
            completion_per_mtok_usd: 10.00,
        },
    ),
    (
        "gpt-5.3",
        ModelPricing {
            prompt_per_mtok_usd: 1.25,
            completion_per_mtok_usd: 10.00,
        },
    ),
    (
        "gpt-4o-mini",
        ModelPricing {
            prompt_per_mtok_usd: 0.15,
            completion_per_mtok_usd: 0.60,
        },
    ),
    (
        "gpt-4o",
        ModelPricing {
            prompt_per_mtok_usd: 2.50,
            completion_per_mtok_usd: 10.00,
        },
    ),
    // -- Anthropic (only used when local-aggregating, e.g. via Pi) -----
    // Fable 5 is priced at 2x Opus. The `[1m]` variant matches this same
    // prefix via `starts_with`, so a single entry covers both ids.
    (
        "claude-fable-5",
        ModelPricing {
            prompt_per_mtok_usd: 30.00,
            completion_per_mtok_usd: 150.00,
        },
    ),
    (
        "claude-opus-4-8",
        ModelPricing {
            prompt_per_mtok_usd: 15.00,
            completion_per_mtok_usd: 75.00,
        },
    ),
    (
        "claude-opus-4-7",
        ModelPricing {
            prompt_per_mtok_usd: 15.00,
            completion_per_mtok_usd: 75.00,
        },
    ),
    (
        "claude-opus-4-6",
        ModelPricing {
            prompt_per_mtok_usd: 15.00,
            completion_per_mtok_usd: 75.00,
        },
    ),
    (
        "claude-opus-4-5",
        ModelPricing {
            prompt_per_mtok_usd: 15.00,
            completion_per_mtok_usd: 75.00,
        },
    ),
    // Sonnet 5 standard list price ($3/$15 per Mtok) — same as Sonnet 4.6.
    // (The launch promo of $2/$10 through 2026-08-31 is intentionally not
    // encoded; this table is a durable reference, not a billing source — the
    // Anthropic Claude CLI path reports cost directly and bypasses this table.)
    // A `[1m]`-suffixed gateway form (`claude-sonnet-5[1m]`) matches via `starts_with`.
    (
        "claude-sonnet-5",
        ModelPricing {
            prompt_per_mtok_usd: 3.00,
            completion_per_mtok_usd: 15.00,
        },
    ),
    (
        "claude-sonnet-4-6",
        ModelPricing {
            prompt_per_mtok_usd: 3.00,
            completion_per_mtok_usd: 15.00,
        },
    ),
    (
        "claude-haiku-4-5",
        ModelPricing {
            prompt_per_mtok_usd: 1.00,
            completion_per_mtok_usd: 5.00,
        },
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_known_model() {
        let p = lookup("gpt-5.4").expect("gpt-5.4 has pricing");
        assert!((p.prompt_per_mtok_usd - 1.25).abs() < f64::EPSILON);
    }

    #[test]
    fn lookup_fable_5_priced_at_2x_opus() {
        let p = lookup("claude-fable-5").expect("claude-fable-5 has pricing");
        assert!((p.prompt_per_mtok_usd - 30.00).abs() < f64::EPSILON);
        assert!((p.completion_per_mtok_usd - 150.00).abs() < f64::EPSILON);
        // The 1M variant shares the bare prefix via `starts_with`.
        let one_m = lookup("claude-fable-5[1m]").expect("1M variant resolves to same pricing");
        assert!((one_m.prompt_per_mtok_usd - 30.00).abs() < f64::EPSILON);
    }

    #[test]
    fn lookup_sonnet_5_priced_same_as_sonnet_4_6() {
        let p = lookup("claude-sonnet-5").expect("claude-sonnet-5 has pricing");
        assert!((p.prompt_per_mtok_usd - 3.00).abs() < f64::EPSILON);
        assert!((p.completion_per_mtok_usd - 15.00).abs() < f64::EPSILON);
        // The 1M variant shares the bare prefix via `starts_with`.
        let one_m = lookup("claude-sonnet-5[1m]").expect("1M variant resolves to same pricing");
        assert!((one_m.prompt_per_mtok_usd - 3.00).abs() < f64::EPSILON);
    }

    #[test]
    fn lookup_handles_provider_prefix() {
        // Pi qualifies model ids as `<provider>/<id>`; the table is
        // keyed on the bare id.
        let p = lookup("openai/gpt-5.4-mini").expect("provider-prefixed lookup");
        assert!((p.prompt_per_mtok_usd - 0.25).abs() < f64::EPSILON);
    }

    #[test]
    fn longer_prefix_wins() {
        // `gpt-5.4-mini` must not collapse onto `gpt-5.4`.
        let mini = lookup("gpt-5.4-mini").unwrap();
        let full = lookup("gpt-5.4").unwrap();
        assert!(mini.prompt_per_mtok_usd < full.prompt_per_mtok_usd);
    }

    #[test]
    fn lookup_unknown_returns_none() {
        assert!(lookup("never-heard-of-it-2030").is_none());
    }

    #[test]
    fn cost_math() {
        let p = ModelPricing {
            prompt_per_mtok_usd: 1.00,
            completion_per_mtok_usd: 2.00,
        };
        // 500k prompt + 250k completion = 0.50 + 0.50 = 1.00
        assert!((p.cost(500_000, 250_000) - 1.00).abs() < 1e-9);
        // Negative inputs (corrupt rows) clamp to zero.
        assert_eq!(p.cost(-100, -100), 0.0);
    }
}
