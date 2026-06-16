//! `ask_user`, `request_review`, `present_conclusion` — agent-callable MCP
//! tools that let *any* backend surface an interactive prompt to the user
//! through Claudette's own UI (not the Claude-CLI-only `AskUserQuestion` /
//! `ExitPlanMode` controls).
//!
//! This module owns only the validation + input-shaping policy. The blocking
//! round-trip (register a pending control, await the user's answer) lives
//! parent-side in `agent_mcp_sink` (Tauri crate); the wire payloads are the
//! `BridgePayload::{AskUser, RequestReview, PresentConclusion}` variants.
//!
//! Two seams import these helpers:
//! - the MCP server (grandchild) calls the `validate_*` functions before it
//!   ships a payload, so malformed agent input fails fast as a tool error
//!   without a socket round-trip;
//! - the sink (parent) calls the `*_card_input` shapers to build the
//!   `original_input` the existing frontend cards already know how to render.

use serde_json::{Value, json};

/// Hard cap on questions per `ask_user` call. Mirrors the 1–4 range the
/// native `AskUserQuestion` UI is designed around (see `AgentQuestionCard`).
pub const MAX_QUESTIONS: usize = 4;
/// Hard cap on options per question. The card renders these as buttons; an
/// "Other"/freeform path always exists, so the model never needs more.
pub const MAX_OPTIONS_PER_QUESTION: usize = 8;
/// Bound on free-text fields so a prompt-injected or runaway call can't push
/// a multi-megabyte string through the socket and into a DB row / UI label.
pub const MAX_SUMMARY_LEN: usize = 16_384;

/// Validate the agent-supplied `questions` argument for `ask_user`.
///
/// Returns the normalized question array on success (ready to embed in the
/// `BridgePayload::AskUser`), or an `Err(reason)` the server surfaces back to
/// the model so it can fix the call. Each question must have a non-empty
/// `question` string; `options`, `header`, and `multiSelect` are optional and
/// passed through so the existing card renders them.
pub fn validate_questions(value: &Value) -> Result<Value, String> {
    let arr = value
        .as_array()
        .ok_or("`questions` must be an array of question objects")?;
    if arr.is_empty() {
        return Err("`questions` must contain at least one question".into());
    }
    if arr.len() > MAX_QUESTIONS {
        return Err(format!(
            "`questions` may contain at most {MAX_QUESTIONS} questions, got {}",
            arr.len()
        ));
    }
    for (i, q) in arr.iter().enumerate() {
        let obj = q
            .as_object()
            .ok_or_else(|| format!("question {i} must be an object"))?;
        let text = obj
            .get("question")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("question {i} is missing a `question` string"))?;
        if text.trim().is_empty() {
            return Err(format!("question {i} has an empty `question`"));
        }
        if text.len() > MAX_SUMMARY_LEN {
            return Err(format!("question {i} `question` text is too long"));
        }
        if let Some(opts) = obj.get("options") {
            let opts = opts
                .as_array()
                .ok_or_else(|| format!("question {i} `options` must be an array"))?;
            if opts.len() > MAX_OPTIONS_PER_QUESTION {
                return Err(format!(
                    "question {i} may have at most {MAX_OPTIONS_PER_QUESTION} options"
                ));
            }
            for (j, opt) in opts.iter().enumerate() {
                let has_label = opt
                    .as_object()
                    .and_then(|o| o.get("label"))
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.trim().is_empty());
                if !has_label {
                    return Err(format!(
                        "question {i} option {j} is missing a non-empty `label`"
                    ));
                }
            }
        }
    }
    Ok(value.clone())
}

/// Validate the `summary` shared by `request_review` and `present_conclusion`.
pub fn validate_summary(summary: &str, field: &str) -> Result<(), String> {
    if summary.trim().is_empty() {
        return Err(format!("`{field}` must not be empty"));
    }
    if summary.len() > MAX_SUMMARY_LEN {
        return Err(format!(
            "`{field}` is too long ({} bytes, max {MAX_SUMMARY_LEN})",
            summary.len()
        ));
    }
    Ok(())
}

/// Shape an `ask_user` request into the `original_input` the existing
/// `AgentQuestionCard` renders. The card keys off `questions`, exactly like
/// the native `AskUserQuestion` tool input — so the same component works
/// regardless of which backend asked.
pub fn ask_card_input(questions: Value) -> Value {
    json!({ "questions": questions })
}

/// Shape a `request_review` request into the `original_input` the existing
/// `PlanApprovalCard` renders (which keys off `plan`). The `claudetteReview`
/// marker lets the frontend distinguish a Claudette-native review (which
/// offers the approve/deny/**suggest** verdicts) from a native `ExitPlanMode`
/// (approve/deny only).
pub fn review_card_input(summary: &str, detail: Option<&str>) -> Value {
    let plan = match detail {
        Some(d) if !d.trim().is_empty() => format!("{summary}\n\n{d}"),
        _ => summary.to_string(),
    };
    json!({
        "plan": plan,
        "claudetteReview": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_array_questions() {
        assert!(validate_questions(&json!({"question": "x"})).is_err());
    }

    #[test]
    fn rejects_empty_questions() {
        assert!(validate_questions(&json!([])).is_err());
    }

    #[test]
    fn rejects_too_many_questions() {
        let qs: Vec<Value> = (0..MAX_QUESTIONS + 1)
            .map(|i| json!({"question": format!("q{i}")}))
            .collect();
        assert!(validate_questions(&Value::Array(qs)).is_err());
    }

    #[test]
    fn rejects_question_without_text() {
        assert!(validate_questions(&json!([{"header": "h"}])).is_err());
        assert!(validate_questions(&json!([{"question": "   "}])).is_err());
    }

    #[test]
    fn rejects_option_without_label() {
        let v = json!([{"question": "q", "options": [{"description": "d"}]}]);
        assert!(validate_questions(&v).is_err());
    }

    #[test]
    fn accepts_well_formed_questions() {
        let v = json!([{
            "question": "Pick one",
            "header": "Choice",
            "multiSelect": false,
            "options": [{"label": "A", "description": "first"}, {"label": "B"}]
        }]);
        assert_eq!(validate_questions(&v).unwrap(), v);
    }

    #[test]
    fn summary_validation() {
        assert!(validate_summary("", "summary").is_err());
        assert!(validate_summary("   ", "summary").is_err());
        assert!(validate_summary("ok", "summary").is_ok());
        let huge = "x".repeat(MAX_SUMMARY_LEN + 1);
        assert!(validate_summary(&huge, "summary").is_err());
    }

    #[test]
    fn ask_card_input_wraps_questions() {
        let qs = json!([{"question": "q"}]);
        let input = ask_card_input(qs.clone());
        assert_eq!(input["questions"], qs);
    }

    #[test]
    fn review_card_input_merges_detail_and_marks_native() {
        let input = review_card_input("Summary", Some("Detail"));
        assert_eq!(input["claudetteReview"], true);
        let plan = input["plan"].as_str().unwrap();
        assert!(plan.contains("Summary"));
        assert!(plan.contains("Detail"));

        // No detail → plan is just the summary.
        let input = review_card_input("Only summary", None);
        assert_eq!(input["plan"], "Only summary");
    }
}
