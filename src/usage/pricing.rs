//! Model pricing used by the OpenAI / OpenRouter cost path, backed by the
//! `llm-prices` crate.
//!
//! Used by [`local_aggregate`](super::local_aggregate) when the
//! `chat_messages.cost_usd` column wasn't populated by the harness
//! (Claude Code populates it; the Codex harness doesn't yet).
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

/// Lookup pricing for a model id. Returns `None` for unknown models, so
/// callers drop the dollar figure rather than guess. Matching is
/// case-insensitive and tolerant of common id variants (`gpt-5.4`,
/// `gpt-5.4-2026-04-01`, `openai/gpt-5.4`, `claude-opus-5-5[1m]`, ...).
///
/// Rates come from the [`llm_prices`] table, which records each model's
/// list price with the provider's pricing page and the date it was checked.
/// A trailing context-window tag such as `[1m]` is stripped first: the
/// gateway uses it to select the 1M-context variant, which bills at the
/// same per-token rates as the bare model id.
pub fn lookup(model_id: &str) -> Option<ModelPricing> {
    let id = model_id.trim();
    let id = match id.rfind('[') {
        Some(i) if id.ends_with(']') => &id[..i],
        _ => id,
    };
    let price = llm_prices::lookup(id)?;
    Some(ModelPricing {
        prompt_per_mtok_usd: price.input?,
        completion_per_mtok_usd: price.output?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_rates(id: &str, prompt: f64, completion: f64) {
        let p = lookup(id).unwrap_or_else(|| panic!("{id} has pricing"));
        assert!(
            (p.prompt_per_mtok_usd - prompt).abs() < 1e-9,
            "{id} prompt: got {}, want {prompt}",
            p.prompt_per_mtok_usd,
        );
        assert!(
            (p.completion_per_mtok_usd - completion).abs() < 1e-9,
            "{id} completion: got {}, want {completion}",
            p.completion_per_mtok_usd,
        );
    }

    /// OpenAI list prices. The previous hand-written table carried GPT-5
    /// launch rates ($1.25 / $10) for every 5.x model, which undercounted
    /// GPT-5.4 by 2x on input and 1.5x on output.
    #[test]
    fn openai_list_prices() {
        assert_rates("gpt-5.4", 2.50, 15.00);
        assert_rates("gpt-5.4-mini", 0.75, 4.50);
        assert_rates("gpt-5.3-codex", 1.75, 14.00);
        assert_rates("gpt-6-sol", 2.00, 10.00);
        assert_rates("gpt-6-luna", 0.10, 0.50);
        assert_rates("gpt-4o", 2.50, 10.00);
        assert_rates("gpt-4o-mini", 0.15, 0.60);
    }

    /// Models the app offers that the old table had no row for, so the
    /// usage meter showed no dollar figure at all.
    #[test]
    fn models_missing_from_the_old_table() {
        assert_rates("gpt-5.5", 5.00, 30.00);
        assert_rates("gpt-5.2", 1.75, 14.00);
        assert_rates("claude-opus-4-20250514", 15.00, 75.00);
    }

    #[test]
    fn anthropic_list_prices() {
        assert_rates("claude-fable-5-2", 8.00, 40.00);
        assert_rates("claude-fable-5-1", 10.00, 50.00);
        assert_rates("claude-fable-5", 10.00, 50.00);
        assert_rates("claude-opus-5-5", 4.00, 20.00);
        assert_rates("claude-opus-5", 5.00, 25.00);
        assert_rates("claude-opus-4-8", 5.00, 25.00);
        assert_rates("claude-opus-4-5", 5.00, 25.00);
        assert_rates("claude-sonnet-4-6", 3.00, 15.00);
        assert_rates("claude-haiku-4-5", 1.00, 5.00);
    }

    /// Sonnet 5's $2 / $10 launch price became its standard price; the
    /// scheduled move to $3 / $15 on 2026-09-01 was cancelled (footnote on
    /// Anthropic's pricing page).
    #[test]
    fn sonnet_5_standard_price() {
        assert_rates("claude-sonnet-5", 2.00, 10.00);
    }

    #[test]
    fn id_variants_resolve() {
        // Dated snapshots and provider-qualified ids (Pi qualifies ids as
        // `<provider>/<id>`) share the bare model's price.
        assert_rates("openai/gpt-6-sol-2026-09-22", 2.00, 10.00);
        assert_rates("gpt-5.4-2026-04-01", 2.50, 15.00);
        assert_rates("openai/gpt-5.4-mini", 0.75, 4.50);
        assert_rates("anthropic/claude-sonnet-5", 2.00, 10.00);
        assert_rates("GPT-5.4", 2.50, 15.00);
        // The `[1m]` gateway form bills at the bare model's rates.
        assert_rates("claude-fable-5-2[1m]", 8.00, 40.00);
        assert_rates("claude-opus-5-5[1m]", 4.00, 20.00);
        assert_rates("claude-sonnet-5[1m]", 2.00, 10.00);
    }

    #[test]
    fn longer_id_wins() {
        // `gpt-5.4-mini` must not collapse onto `gpt-5.4`, nor
        // `claude-fable-5-2` onto `claude-fable-5`.
        let mini = lookup("gpt-5.4-mini").unwrap();
        let full = lookup("gpt-5.4").unwrap();
        assert!(mini.prompt_per_mtok_usd < full.prompt_per_mtok_usd);
        let f52 = lookup("claude-fable-5-2").unwrap();
        let f5 = lookup("claude-fable-5").unwrap();
        assert!(f52.prompt_per_mtok_usd < f5.prompt_per_mtok_usd);
    }

    #[test]
    fn lookup_unknown_returns_none() {
        assert!(lookup("never-heard-of-it-2030").is_none());
        assert!(lookup("").is_none());
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
