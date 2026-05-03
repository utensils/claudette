//! `claudette` CLI — command-line client for the running Claudette
//! desktop app.
//!
//! Architecture: every subcommand resolves to a single JSON-RPC call
//! over a per-user local socket the GUI advertises in
//! `${state_dir}/Claudette/app.json`. The CLI never opens the SQLite
//! database directly; the GUI owns all writes so its tray rebuilds,
//! notifications, and event subscribers stay consistent. If the GUI
//! isn't running the CLI exits with a clear "open the desktop app
//! first" message rather than silently degrading.

mod batch;
mod commands;
mod discovery;
mod ipc;
mod output;

use clap::{CommandFactory, Parser, Subcommand};

use crate::commands::{batch as batch_cmd, capabilities, chat, repo, rpc, version, workspace};

#[derive(Parser)]
#[command(
    name = "claudette",
    version,
    about = "Command-line client for the Claudette desktop app",
    long_about = "Drives the running Claudette GUI over a local socket. \
                  All operations require the desktop app to be open. \
                  See `claudette capabilities` for available methods."
)]
struct Cli {
    /// Print machine-readable JSON instead of a human-readable table.
    /// Currently a no-op for commands that already speak JSON
    /// (`capabilities`, `rpc`); future table-rendering commands will
    /// honour this flag.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print app + protocol version of the running GUI.
    Version,

    /// List the methods the running GUI accepts over IPC.
    /// Output: JSON object with `protocol`, `version`, `methods`.
    Capabilities,

    /// Issue a raw JSON-RPC call. Escape hatch for methods that don't
    /// have a typed subcommand yet, mirrors `cmux rpc`. Example:
    /// `claudette rpc list_workspaces`
    Rpc {
        /// Method name, e.g. `list_workspaces`, `create_workspace`.
        method: String,
        /// JSON-encoded params object. Defaults to `{}`. When omitted
        /// for methods that accept no params (`list_workspaces`), pass
        /// `{}` explicitly.
        #[arg(default_value = "{}")]
        params: String,
    },

    /// Workspace operations.
    #[command(alias = "ws")]
    Workspace {
        #[command(subcommand)]
        action: workspace::Action,
    },

    /// Chat session operations.
    Chat {
        #[command(subcommand)]
        action: chat::Action,
    },

    /// Repository registry operations.
    Repo {
        #[command(subcommand)]
        action: repo::Action,
    },

    /// Batch manifest operations — declarative fan-out for
    /// multi-workspace workflows.
    Batch {
        #[command(subcommand)]
        action: batch_cmd::Action,
    },

    /// Generate shell completion script for the named shell.
    /// Pipe to your shell's completion file:
    ///   `claudette completion zsh > ~/.zsh/completions/_claudette`
    Completion {
        /// Target shell.
        shell: clap_complete::Shell,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Version => version::run().await,
        Command::Capabilities => capabilities::run(cli.json).await,
        Command::Rpc { method, params } => rpc::run(&method, &params, cli.json).await,
        Command::Workspace { action } => workspace::run(action, cli.json).await,
        Command::Chat { action } => chat::run(action, cli.json).await,
        Command::Repo { action } => repo::run(action, cli.json).await,
        Command::Batch { action } => batch_cmd::run(action).await,
        Command::Completion { shell } => {
            let mut cmd = Cli::command();
            let bin_name = cmd.get_name().to_string();
            clap_complete::generate(shell, &mut cmd, bin_name, &mut std::io::stdout());
            Ok(())
        }
    };
    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
