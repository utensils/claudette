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
    fn derive_overall_cancelled_counts_as_success() {
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
        ];
        assert_eq!(
            derive_overall_ci_status(&checks),
            Some(CiOverallStatus::Success)
        );
    }
}
