use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    // Get the target triple
    let target = env::var("TARGET").expect("TARGET not set");

    // Get the profile (debug or release)
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());

    // NOTE: We can't run `cargo build` from within build.rs because it causes a deadlock
    // with Cargo's workspace lock. Instead, we look for an already-built server binary
    // and copy it to the sidecar location. Users/CI must build the server separately first.

    let workspace_root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .parent()
        .unwrap()
        .to_path_buf();

    // Look for the server binary in the standard target directory
    let mut server_binary = workspace_root
        .join("target")
        .join(&profile)
        .join("claudette-server");
    if target.contains("windows") {
        server_binary.set_extension("exe");
    }

    // Create binaries directory
    let binaries_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("binaries");
    fs::create_dir_all(&binaries_dir).expect("Failed to create binaries directory");

    // Copy to sidecar location with target triple suffix
    let mut dest = binaries_dir.join(format!("claudette-server-{}", target));
    if target.contains("windows") {
        dest.set_extension("exe");
    }

    // Only copy if the server binary exists; otherwise warn but don't fail
    // This allows the tauri app to build even if the server isn't needed yet
    if server_binary.exists() {
        fs::copy(&server_binary, &dest).unwrap_or_else(|e| {
            panic!(
                "Failed to copy claudette-server binary from {:?} to {:?}: {}",
                server_binary, dest, e
            )
        });
        println!(
            "cargo:warning=Copied claudette-server from {:?} to {:?}",
            server_binary, dest
        );
    } else {
        println!(
            "cargo:warning=claudette-server binary not found at {:?}. Build it first with: cargo build --package claudette-server",
            server_binary
        );
        println!(
            "cargo:warning=The Tauri app will build, but 'Share this machine' will not work until the server is built."
        );
    }

    // Trigger rebuild when server source changes or env vars change
    println!("cargo:rerun-if-changed=../src-server/Cargo.toml");
    println!("cargo:rerun-if-changed=../src-server/src");
    println!("cargo:rerun-if-env-changed=TARGET");
    println!("cargo:rerun-if-env-changed=PROFILE");

    // Run tauri_build AFTER creating the sidecar binary
    tauri_build::build();
}
