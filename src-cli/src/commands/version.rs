//! `claudette version` — print the running GUI's app version alongside
//! the CLI's own version. Reports a mismatch as a warning so users notice
//! when the .app bundle and the bundled CLI binary drift apart.

use std::error::Error;

use crate::{discovery, ipc};

pub async fn run() -> Result<(), Box<dyn Error>> {
    let cli_version = env!("CARGO_PKG_VERSION");
    println!("claudette-cli {cli_version}");

    match discovery::read_app_info() {
        Ok(info) => {
            let value = ipc::call(&info, "version", serde_json::json!({})).await?;
            let app_version = value
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            println!("claudette-app {app_version} (pid {})", info.pid);
            if app_version != cli_version {
                eprintln!(
                    "warning: CLI version ({cli_version}) does not match running GUI \
                     ({app_version}). Reinstall the bundled CLI to keep them in sync."
                );
            }
        }
        Err(e) => {
            eprintln!("note: GUI not reachable ({e})");
        }
    }
    Ok(())
}
