//! Decides whether a merged pull request actually authorizes archiving the
//! workspace that resolved it.
//!
//! The SCM poller resolves a workspace's PR by branch name alone
//! (`gh pr list --state all --head <branch>` — `--state all` is deliberate so
//! the sidebar badge still renders for merged/closed PRs). A merged PR
//! therefore keeps resolving for its branch name forever, including for a
//! *different* workspace that later lands on the same branch name — which the
//! first-prompt branch auto-rename makes easy, since two similar prompts
//! produce the same slug. Combined with `git_delete_branch_on_archive`, which
//! erases both the local branch and the workspace row that name allocation
//! checks against, a brand-new workspace could inherit a days-old merged PR
//! and be hard-deleted seconds after its first prompt, killing the running
//! agent with it.
//!
//! Two independent signals can authorize archiving here, and **either one is
//! sufficient**:
//!
//! 1. **Merge time** — the PR merged at or after the workspace was created,
//!    so the merge plausibly came from this workspace's work.
//! 2. **Observed transition** — this process watched the *same PR number* go
//!    from a non-merged state to merged while polling this workspace.
//!
//! Requiring only one keeps the feature working where the other can't apply:
//! signal 2 covers providers that report no merge timestamp (third-party
//! plugins, older cached rows), and signal 1 covers app restarts, where no
//! transition can have been observed. A merged PR adopted through a branch
//! name collision satisfies neither.

use chrono::{DateTime, NaiveDateTime, Utc};

use super::types::{PrState, PullRequest};

/// The pull request state the SCM poller last saw for a workspace.
///
/// Tracked per workspace (not per branch) so a branch rename resets the
/// history rather than inheriting the previous branch's observations.
#[derive(Debug, Clone, PartialEq)]
pub struct ObservedPr {
    pub number: u64,
    pub state: PrState,
}

impl ObservedPr {
    pub fn from_pr(pr: &PullRequest) -> Self {
        Self {
            number: pr.number,
            state: pr.state.clone(),
        }
    }
}

/// Outcome of [`evaluate`]. Non-`Archive` variants name the reason so the
/// poller can log why it declined rather than silently doing nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoArchiveVerdict {
    /// The merge belongs to this workspace — go ahead and archive.
    Archive,
    /// The PR isn't merged. Not a skip, just the common case.
    NotMerged,
    /// The PR merged before this workspace existed and no transition was
    /// observed: the workspace adopted someone else's PR via its branch name.
    PrPredatesWorkspace,
    /// No usable merge timestamp and no observed transition, so there's no
    /// evidence tying the merge to this workspace. Declining is the safe
    /// default — archiving is destructive and not reliably reversible.
    Unverifiable,
}

/// Decide whether `pr` being merged authorizes archiving the workspace.
///
/// `workspace_created_at` accepts any of the shapes this codebase produces:
/// SQLite `datetime('now')` (`"YYYY-MM-DD HH:MM:SS"`, UTC — what the
/// `workspaces.created_at` column default actually writes), RFC 3339, or
/// epoch seconds. `previously_observed` is the last state this process saw
/// for the *same workspace*, or `None` if it has never seen a PR there.
pub fn evaluate(
    pr: &PullRequest,
    workspace_created_at: &str,
    previously_observed: Option<&ObservedPr>,
) -> AutoArchiveVerdict {
    if pr.state != PrState::Merged {
        return AutoArchiveVerdict::NotMerged;
    }

    // Same PR number is required: a stale observation of a *different* PR
    // (from the branch this workspace had before it was auto-renamed) says
    // nothing about whether this merge is ours.
    let observed_transition = previously_observed
        .is_some_and(|prev| prev.number == pr.number && prev.state != PrState::Merged);

    let merged_at = parse_timestamp(pr.merged_at.as_deref());
    let created_at = parse_timestamp(Some(workspace_created_at));

    match (merged_at, created_at) {
        (Some(merged), Some(created)) => {
            if merged >= created || observed_transition {
                AutoArchiveVerdict::Archive
            } else {
                AutoArchiveVerdict::PrPredatesWorkspace
            }
        }
        _ => {
            if observed_transition {
                AutoArchiveVerdict::Archive
            } else {
                AutoArchiveVerdict::Unverifiable
            }
        }
    }
}

/// Parse the timestamp shapes that reach this module.
///
/// Providers emit RFC 3339 (`gh --json mergedAt`, `glab`'s `merged_at`);
/// `workspaces.created_at` comes from SQLite's `datetime('now')` column
/// default, which is space-separated UTC with no offset marker; and
/// `ops::workspace::create` builds an epoch-seconds string in memory for the
/// struct it hands back before the row is read again.
fn parse_timestamp(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(naive) = NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S") {
        return Some(naive.and_utc());
    }
    if let Ok(secs) = raw.parse::<i64>() {
        return DateTime::from_timestamp(secs, 0);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: u64, state: PrState, merged_at: Option<&str>) -> PullRequest {
        PullRequest {
            number,
            title: "t".into(),
            state,
            url: "https://example.test/pr".into(),
            author: "someone".into(),
            branch: "doomspork/fix-insights-rendering".into(),
            base: "main".into(),
            draft: false,
            ci_status: None,
            merged_at: merged_at.map(str::to_string),
        }
    }

    #[test]
    fn open_pr_is_not_merged() {
        assert_eq!(
            evaluate(&pr(1, PrState::Open, None), "2026-08-07 17:06:00", None),
            AutoArchiveVerdict::NotMerged
        );
    }

    /// The reported regression: a workspace created on Aug 7 adopts a PR that
    /// merged on Aug 5 purely because the auto-rename gave it the same branch
    /// name as an earlier, already-deleted workspace.
    #[test]
    fn merged_before_workspace_existed_is_refused() {
        assert_eq!(
            evaluate(
                &pr(1016, PrState::Merged, Some("2026-08-05T22:54:34Z")),
                "2026-08-07 17:06:00",
                None,
            ),
            AutoArchiveVerdict::PrPredatesWorkspace
        );
    }

    #[test]
    fn merged_after_workspace_created_is_archived() {
        assert_eq!(
            evaluate(
                &pr(1016, PrState::Merged, Some("2026-08-07T18:30:00Z")),
                "2026-08-07 17:06:00",
                None,
            ),
            AutoArchiveVerdict::Archive
        );
    }

    /// A clock skewed such that the local created_at lands after the remote
    /// merge time must not block an archive we actually watched happen.
    #[test]
    fn observed_transition_overrides_timestamp_skew() {
        let observed = ObservedPr {
            number: 1016,
            state: PrState::Open,
        };
        assert_eq!(
            evaluate(
                &pr(1016, PrState::Merged, Some("2026-08-05T22:54:34Z")),
                "2026-08-07 17:06:00",
                Some(&observed),
            ),
            AutoArchiveVerdict::Archive
        );
    }

    /// Providers that report no merge timestamp still work via the observed
    /// open→merged transition.
    #[test]
    fn transition_authorizes_archive_without_timestamp() {
        let observed = ObservedPr {
            number: 42,
            state: PrState::Open,
        };
        assert_eq!(
            evaluate(
                &pr(42, PrState::Merged, None),
                "2026-08-07 17:06:00",
                Some(&observed),
            ),
            AutoArchiveVerdict::Archive
        );
    }

    #[test]
    fn draft_to_merged_counts_as_a_transition() {
        let observed = ObservedPr {
            number: 42,
            state: PrState::Draft,
        };
        assert_eq!(
            evaluate(
                &pr(42, PrState::Merged, None),
                "2026-08-07 17:06:00",
                Some(&observed),
            ),
            AutoArchiveVerdict::Archive
        );
    }

    /// An observation of a *different* PR — the one on the branch this
    /// workspace had before it was auto-renamed — is not a transition.
    #[test]
    fn observation_of_a_different_pr_is_not_a_transition() {
        let observed = ObservedPr {
            number: 900,
            state: PrState::Open,
        };
        assert_eq!(
            evaluate(
                &pr(1016, PrState::Merged, None),
                "2026-08-07 17:06:00",
                Some(&observed),
            ),
            AutoArchiveVerdict::Unverifiable
        );
    }

    #[test]
    fn already_merged_observation_is_not_a_transition() {
        let observed = ObservedPr {
            number: 1016,
            state: PrState::Merged,
        };
        assert_eq!(
            evaluate(
                &pr(1016, PrState::Merged, None),
                "2026-08-07 17:06:00",
                Some(&observed),
            ),
            AutoArchiveVerdict::Unverifiable
        );
    }

    #[test]
    fn no_timestamp_and_no_history_is_refused() {
        assert_eq!(
            evaluate(
                &pr(1016, PrState::Merged, None),
                "2026-08-07 17:06:00",
                None
            ),
            AutoArchiveVerdict::Unverifiable
        );
    }

    #[test]
    fn unparseable_created_at_falls_back_to_transition_only() {
        assert_eq!(
            evaluate(
                &pr(1016, PrState::Merged, Some("2026-08-07T18:30:00Z")),
                "",
                None,
            ),
            AutoArchiveVerdict::Unverifiable
        );
    }

    #[test]
    fn parses_the_timestamp_shapes_this_codebase_produces() {
        // SQLite datetime('now') — the workspaces.created_at column default.
        let sqlite = parse_timestamp(Some("2026-08-07 17:06:00")).unwrap();
        // RFC 3339 from gh / glab.
        let rfc = parse_timestamp(Some("2026-08-07T17:06:00Z")).unwrap();
        assert_eq!(sqlite, rfc);

        // Offset-bearing RFC 3339 normalizes to UTC.
        assert_eq!(
            parse_timestamp(Some("2026-08-07T13:06:00-04:00")).unwrap(),
            rfc
        );

        // Epoch seconds — ops::workspace::create's in-memory shape.
        assert_eq!(parse_timestamp(Some("1786122360")).unwrap(), rfc);

        assert!(parse_timestamp(None).is_none());
        assert!(parse_timestamp(Some("   ")).is_none());
        assert!(parse_timestamp(Some("not a date")).is_none());
    }

    /// Pins the contract between the `workspaces.created_at` column default
    /// and the merge-time guard. If that format ever drifts out of
    /// [`parse_timestamp`]'s reach, `evaluate` silently degrades to
    /// transition-only and auto-archive stops firing across restarts — a
    /// failure that is invisible without this test.
    #[test]
    fn persisted_workspace_created_at_is_parseable() {
        let db = crate::db::test_support::setup_db_with_workspace();
        let ws = db.list_workspaces().unwrap().pop().unwrap();
        assert!(
            parse_timestamp(Some(&ws.created_at)).is_some(),
            "workspaces.created_at {:?} is not a shape parse_timestamp understands",
            ws.created_at
        );
    }
}
