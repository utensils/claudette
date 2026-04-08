use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // Get the target triple
    let target = env::var("TARGET").expect("TARGET not set");

    // Get the profile (debug or release)
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());

    // Compile the claudette-server binary BEFORE running tauri_build
    let mut args = vec![
        "build",
        "--package",
        "claudette-server",
        "--target",
        &target,
    ];
    if profile == "release" {
        args.push("--release");
    }

    let status = Command::new("cargo")
        .args(&args)
        .status()
        .expect("Failed to build claudette-server");

    if !status.success() {
        panic!("Failed to compile claudette-server");
    }

    // Determine the path to the compiled binary
    let workspace_root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .parent()
        .unwrap()
        .to_path_buf();

    let mut server_binary = workspace_root
        .join("target")
        .join(&target)
        .join(&profile)
        .join("claudette-server");

    // Add .exe extension on Windows targets
    if target.contains("windows") {
        server_binary.set_extension("exe");
    }

    // Create binaries directory if it doesn't exist
    let binaries_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("binaries");
    fs::create_dir_all(&binaries_dir).expect("Failed to create binaries directory");

    // Copy to the correct location with target triple suffix
    let mut dest = binaries_dir.join(format!("claudette-server-{}", target));
    if target.contains("windows") {
        dest.set_extension("exe");
    }
    fs::copy(&server_binary, &dest).expect("Failed to copy claudette-server binary");

    // Trigger rebuild when server source changes or env vars change
    println!("cargo:rerun-if-changed=../src-server/Cargo.toml");
    println!("cargo:rerun-if-changed=../src-server/src");
    println!("cargo:rerun-if-env-changed=TARGET");
    println!("cargo:rerun-if-env-changed=PROFILE");

    // Run tauri_build AFTER creating the sidecar binary
    tauri_build::build();
}
