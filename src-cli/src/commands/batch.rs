//! `claudette batch …` — declarative fan-out for multi-workspace
//! workflows. The flagship use case: a phase-of-work plan that
//! creates 8 workspaces and dispatches a prompt to each.

use std::error::Error;
use std::path::PathBuf;

use clap::Subcommand;

use crate::batch;

#[derive(Subcommand)]
pub enum Action {
    /// Run a manifest: create each workspace and dispatch its prompt.
    Run {
        /// Path to the YAML or JSON manifest.
        manifest: PathBuf,
    },
    /// Parse + lint a manifest without creating any workspaces.
    /// Catches duplicate names, missing prompts, and prompt_file paths
    /// that don't exist on disk.
    Validate {
        /// Path to the YAML or JSON manifest.
        manifest: PathBuf,
    },
}

pub async fn run(action: Action) -> Result<(), Box<dyn Error>> {
    match action {
        Action::Run { manifest } => batch::run(&manifest).await,
        Action::Validate { manifest } => {
            let parsed = batch::load(&manifest)?;
            batch::validate(&parsed, &manifest)?;
            println!(
                "ok: {} workspace(s) in repository '{}'",
                parsed.workspaces.len(),
                parsed.repository
            );
            Ok(())
        }
    }
}
