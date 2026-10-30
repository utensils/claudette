//! `claudette routine …` — native scheduled agent routines.

use std::error::Error;

use clap::Subcommand;

use crate::{discovery, ipc, output};

#[derive(Subcommand)]
pub enum Action {
    /// List scheduled wakeups and routines.
    List,
    /// Create a cron-style routine for a chat session.
    Create {
        /// Chat session ID.
        session: String,
        /// Standard 5-field cron expression in local time.
        cron: String,
        /// Prompt to send when the routine fires. Supports @file or - for stdin.
        prompt: String,
        /// Optional stable name for run/delete.
        #[arg(long)]
        name: Option<String>,
        /// Fire once at the next matching time, then disable.
        #[arg(long)]
        once: bool,
    },
    /// Delete a routine by id or name.
    Delete {
        /// Routine id or name.
        id: String,
    },
    /// Run a routine immediately by id or name.
    Run {
        /// Routine id or name.
        id: String,
    },
    /// Pause a routine or wakeup so it stops firing until resumed.
    Pause {
        /// Routine id or name.
        id: String,
    },
    /// Resume a paused or auto-disabled routine or wakeup.
    Resume {
        /// Routine id or name.
        id: String,
    },
}

pub async fn run(action: Action, json: bool) -> Result<(), Box<dyn Error>> {
    let info = discovery::read_app_info()?;
    match action {
        Action::List => {
            let value = ipc::call(&info, "routine.list", serde_json::json!({})).await?;
            output::print_json(&value)?;
        }
        Action::Create {
            session,
            cron,
            prompt,
            name,
            once,
        } => {
            let content = super::chat::resolve_prompt(&prompt)?;
            let value = ipc::call(
                &info,
                "routine.create",
                serde_json::json!({
                    "session_id": session,
                    "cron": cron,
                    "prompt": content,
                    "name": name,
                    "recurring": !once,
                }),
            )
            .await?;
            if json {
                output::print_json(&value)?;
            } else {
                let id = value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<unknown>");
                println!("scheduled {id}");
            }
        }
        Action::Delete { id } => {
            let value = ipc::call(&info, "routine.delete", serde_json::json!({ "id": id })).await?;
            if json {
                output::print_json(&value)?;
            } else {
                println!("ok");
            }
        }
        Action::Run { id } => {
            let value = ipc::call(&info, "routine.run", serde_json::json!({ "id": id })).await?;
            if json {
                output::print_json(&value)?;
            } else {
                println!("ok");
            }
        }
        Action::Pause { id } => {
            let value = ipc::call(&info, "routine.pause", serde_json::json!({ "id": id })).await?;
            if json {
                output::print_json(&value)?;
            } else {
                println!("paused");
            }
        }
        Action::Resume { id } => {
            let value = ipc::call(&info, "routine.resume", serde_json::json!({ "id": id })).await?;
            if json {
                output::print_json(&value)?;
            } else {
                let next = value
                    .get("next_fire_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<unscheduled>");
                println!("resumed; next fire {next}");
            }
        }
    }
    Ok(())
}
