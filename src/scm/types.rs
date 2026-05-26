use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CiOverallStatus {
    Pending,
    Success,
    Failure,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub state: PrState,
    pub url: String,
    pub author: String,
    pub branch: String,
    pub base: String,
    pub draft: bool,
    pub ci_status: Option<CiOverallStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CiCheckStatus {
    Pending,
    Success,
    Failure,
    Cancelled,
    /// Check that was deliberately not run (a GitHub workflow whose
    /// `if:` condition was false / a GitLab job whose `rules:` excluded
    /// it / a `manual` GitLab job that wasn't triggered). Distinct from
    /// `Cancelled` (interrupted mid-run) so the UI can render it as
    /// informational rather than soft-fail — without this variant the
    /// SCM plugins fell back to `Pending` and the frontend mapper
    /// surfaced merged-PR skipped checks as "Running".
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CiCheck {
    pub name: String,
    pub status: CiCheckStatus,
    pub url: Option<String>,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CiFailureLog {
    pub check_name: String,
    pub log: String,
    pub url: Option<String>,
}

pub fn derive_overall_ci_status(checks: &[CiCheck]) -> Option<CiOverallStatus> {
    if checks.is_empty() {
        return None;
    }
    if checks.iter().any(|c| c.status == CiCheckStatus::Pending) {
        return Some(CiOverallStatus::Pending);
    }
    if checks.iter().any(|c| c.status == CiCheckStatus::Failure) {
        return Some(CiOverallStatus::Failure);
    }
    Some(CiOverallStatus::Success)
}

/// Expected argument shape for create_pull_request operations.
/// Used by Lua plugins — the Rust side passes args as serde_json::Value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct CreatePrArgs {
    pub title: String,
    pub body: String,
    pub base: String,
    pub draft: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IssueLabel {
    pub name: String,
    /// Hex color without leading `#` (matches GitHub / GitLab payload shape).
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: IssueState,
    pub author: Option<String>,
    #[serde(default)]
    pub labels: Vec<IssueLabel>,
    #[serde(default)]
    pub comment_count: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// Scope filter for repo-wide `list_pull_requests` calls (the project-view
/// aggregation path; the per-workspace branch lookup uses the `branch` arg
/// instead).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestScope {
    Open,
    Mine,
    ReviewRequested,
}

impl PullRequestScope {
    /// String form used as part of the `repo_scm_lists_cache.list_kind`
    /// composite key. Stable; do not rename without a migration.
    pub fn as_cache_segment(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Mine => "mine",
            Self::ReviewRequested => "review_requested",
        }
    }
}

/// Scope filter for repo-wide `list_issues` calls (the project-view
/// aggregation path). `Mine` matches issues you opened (authored);
/// `Assigned` matches issues assigned to you. The two are kept
/// separate rather than unioned because "what did I file?" and
/// "what's on my plate?" are meaningfully different workflows. There
/// is no `ReviewRequested` variant — GitHub issues have no
/// review-requested concept (that's PRs only, via [`PullRequestScope`]).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IssueScope {
    Open,
    Mine,
    Assigned,
}

impl IssueScope {
    /// String form used as part of the `repo_scm_lists_cache.list_kind`
    /// composite key. Stable; do not rename without a migration. The
    /// legacy `"issues"` row written before the scope tab existed is left
    /// to expire from the cache (the next poll repopulates under the
    /// scoped key).
    pub fn as_cache_segment(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Mine => "mine",
            Self::Assigned => "assigned",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ci_check_status_serializes_to_snake_case_strings() {
        let cases: &[(CiCheckStatus, &str)] = &[
            (CiCheckStatus::Pending, "\"pending\""),
            (CiCheckStatus::Success, "\"success\""),
            (CiCheckStatus::Failure, "\"failure\""),
            (CiCheckStatus::Cancelled, "\"cancelled\""),
            (CiCheckStatus::Skipped, "\"skipped\""),
        ];
        for (status, expected) in cases {
            let serialized = serde_json::to_string(status).unwrap();
            assert_eq!(&serialized, expected, "serializing {status:?}");
            let round: CiCheckStatus = serde_json::from_str(&serialized).unwrap();
            assert_eq!(&round, status, "round-trip {status:?}");
        }
    }

    #[test]
    fn derive_overall_empty() {
        assert_eq!(derive_overall_ci_status(&[]), None);
    }

    #[test]
    fn derive_overall_all_success() {
        let checks = vec![
            CiCheck {
                name: "build".into(),
                status: CiCheckStatus::Success,
                url: None,
                started_at: None,
            },
            CiCheck {
                name: "test".into(),
                status: CiCheckStatus::Success,
                url: None,
                started_at: None,
            },
        ];
        assert_eq!(
            derive_overall_ci_status(&checks),
            Some(CiOverallStatus::Success)
        );
    }

    #[test]
    fn derive_overall_any_pending() {
        let checks = vec![
            CiCheck {
                name: "build".into(),
                status: CiCheckStatus::Success,
                url: None,
                started_at: None,
            },
            CiCheck {
                name: "test".into(),
                status: CiCheckStatus::Pending,
                url: None,
                started_at: None,
            },
        ];
        assert_eq!(
            derive_overall_ci_status(&checks),
            Some(CiOverallStatus::Pending)
        );
    }

    #[test]
    fn derive_overall_failure_without_pending() {
        let checks = vec![
            CiCheck {
                name: "build".into(),
                status: CiCheckStatus::Failure,
                url: None,
                started_at: None,
            },
            CiCheck {
                name: "test".into(),
                status: CiCheckStatus::Success,
                url: None,
                started_at: None,
            },
        ];
        assert_eq!(
            derive_overall_ci_status(&checks),
            Some(CiOverallStatus::Failure)
        );
    }

    #[test]
    fn derive_overall_pending_takes_precedence_over_failure() {
        let checks = vec![
            CiCheck {
                name: "build".into(),
                status: CiCheckStatus::Failure,
                url: None,
                started_at: None,
            },
            CiCheck {
                name: "test".into(),
                status: CiCheckStatus::Pending,
                url: None,
                started_at: None,
            },
        ];
        assert_eq!(
            derive_overall_ci_status(&checks),
            Some(CiOverallStatus::Pending)
        );
    }

    #[test]
    fn issue_state_serializes_to_snake_case() {
        let cases: &[(IssueState, &str)] = &[
            (IssueState::Open, "\"open\""),
            (IssueState::Closed, "\"closed\""),
        ];
        for (state, expected) in cases {
            let serialized = serde_json::to_string(state).unwrap();
            assert_eq!(&serialized, expected);
            let round: IssueState = serde_json::from_str(&serialized).unwrap();
            assert_eq!(&round, state);
        }
    }

    #[test]
    fn pull_request_scope_cache_segments_are_stable() {
        assert_eq!(PullRequestScope::Open.as_cache_segment(), "open");
        assert_eq!(PullRequestScope::Mine.as_cache_segment(), "mine");
        assert_eq!(
            PullRequestScope::ReviewRequested.as_cache_segment(),
            "review_requested"
        );
    }

    #[test]
    fn issue_scope_cache_segments_are_stable() {
        assert_eq!(IssueScope::Open.as_cache_segment(), "open");
        assert_eq!(IssueScope::Mine.as_cache_segment(), "mine");
        assert_eq!(IssueScope::Assigned.as_cache_segment(), "assigned");
    }

    #[test]
    fn issue_scope_serializes_to_snake_case() {
        let cases: &[(IssueScope, &str)] = &[
            (IssueScope::Open, "\"open\""),
            (IssueScope::Mine, "\"mine\""),
            (IssueScope::Assigned, "\"assigned\""),
        ];
        for (scope, expected) in cases {
            let serialized = serde_json::to_string(scope).unwrap();
            assert_eq!(&serialized, expected);
            let round: IssueScope = serde_json::from_str(&serialized).unwrap();
            assert_eq!(&round, scope);
        }
    }

    #[test]
    fn issue_round_trips_through_json() {
        let issue = Issue {
            number: 42,
            title: "hello".into(),
            url: "https://example/issues/42".into(),
            state: IssueState::Open,
            author: Some("octocat".into()),
            labels: vec![IssueLabel {
                name: "bug".into(),
                color: "ee0701".into(),
            }],
            comment_count: 3,
            created_at: "2026-05-19T00:00:00Z".into(),
            updated_at: "2026-05-19T01:00:00Z".into(),
        };
        let s = serde_json::to_string(&issue).unwrap();
        let back: Issue = serde_json::from_str(&s).unwrap();
        assert_eq!(back.number, 42);
        assert_eq!(back.title, "hello");
        assert_eq!(back.state, IssueState::Open);
        assert_eq!(back.labels.len(), 1);
        assert_eq!(back.labels[0].name, "bug");
        assert_eq!(back.comment_count, 3);
    }

    #[test]
    fn issue_deserializes_with_missing_optional_fields() {
        // Plugins may omit `labels` and `comment_count` for repos that lack
        // the info (e.g. user-authored plugins). Defaults must kick in.
        let json = r#"{
            "number": 7,
            "title": "x",
            "url": "https://e/issues/7",
            "state": "open",
            "author": null,
            "created_at": "2026-05-19T00:00:00Z",
            "updated_at": "2026-05-19T00:00:00Z"
        }"#;
        let issue: Issue = serde_json::from_str(json).unwrap();
        assert!(issue.labels.is_empty());
        assert_eq!(issue.comment_count, 0);
        assert!(issue.author.is_none());
    }

    #[test]
    fn derive_overall_non_blocking_statuses_count_as_success() {
        let checks = vec![
            CiCheck {
                name: "build".into(),
                status: CiCheckStatus::Cancelled,
                url: None,
                started_at: None,
            },
            CiCheck {
                name: "test".into(),
                status: CiCheckStatus::Success,
                url: None,
                started_at: None,
            },
            CiCheck {
                name: "docs".into(),
                status: CiCheckStatus::Skipped,
                url: None,
                started_at: None,
            },
        ];
        assert_eq!(
            derive_overall_ci_status(&checks),
            Some(CiOverallStatus::Success)
        );
    }
}
