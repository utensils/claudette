//! SCM (source control management) domain types and detection logic.
//!
//! This module is a consumer of the generic `plugin_runtime` — it holds
//! the data types returned by SCM plugin operations (`PullRequest`,
//! `CiCheck`, etc.) and the remote-URL heuristics used to pick the right
//! plugin for a given repository.
//!
//! The actual plugin execution happens in `crate::plugin_runtime`; this
//! module just provides the SCM-specific shapes on top.

pub mod detect;
pub mod types;
