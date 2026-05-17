//! Codex Native usage source.
//!
//! Codex's app-server doesn't expose live rate-limit / quota numbers
//! over JSON-RPC — its `account/read` method returns
//! `{ authenticated, account_type, plan_type, requires_openai_auth,
//!   email }` and nothing more.
//!
//! For the indicator we use that data to produce a tier label
//! ("Codex Plus") that goes into the snapshot header, then let
//! [`local_aggregate`](super::local_aggregate) fill in the actual
//! per-session / per-day token totals from `chat_messages`. The result
//! is a snapshot that surfaces *something useful* even without
//! upstream quota data.

/// Capitalize a plan label like `"plus"` → `"Plus"`. Used to build the
/// `source_label` shown in the popover header.
pub fn format_plan_label(plan_type: Option<&str>) -> String {
    match plan_type {
        Some(plan) if !plan.is_empty() => {
            let mut chars = plan.chars();
            let head = chars.next().unwrap().to_uppercase().collect::<String>();
            format!("Codex {head}{rest}", rest = chars.as_str())
        }
        _ => String::from("Codex"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_plan_label_capitalizes_known_plans() {
        assert_eq!(format_plan_label(Some("plus")), "Codex Plus");
        assert_eq!(format_plan_label(Some("pro")), "Codex Pro");
        assert_eq!(format_plan_label(Some("team")), "Codex Team");
    }

    #[test]
    fn format_plan_label_falls_back_when_missing() {
        assert_eq!(format_plan_label(None), "Codex");
        assert_eq!(format_plan_label(Some("")), "Codex");
    }
}
