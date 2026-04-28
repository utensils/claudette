// All Swift-bridge plumbing is macOS-only; gating the imports keeps
// non-macOS builds free of unused-import warnings under `-Dwarnings`.
#[cfg(target_os = "macos")]
use std::env;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;

fn main() {
    #[cfg(target_os = "macos")]
    compile_platform_speech_swift();

    tauri_build::build();
}

#[cfg(target_os = "macos")]
fn compile_platform_speech_swift() {
    // Detect missing swiftc gracefully — a pure Nix sandbox build has
    // xcrun (from apple-sdk) but no Swift toolchain. Skipping here lets
    // `cargo check` and `cargo clippy` run inside the sandbox; the
    // resulting object files won't satisfy the Speech-framework linker
    // step, so full binary builds must still run outside the sandbox
    // with a working Xcode toolchain.
    let swiftc_available = Command::new("xcrun")
        .args(["--find", "swiftc"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !swiftc_available {
        println!(
            "cargo:warning=swiftc not found; skipping Apple Speech Swift bridge. Full Tauri builds require Xcode."
        );
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("out dir"));
    let source = manifest_dir.join("macos").join("PlatformSpeech.swift");
    let library = out_dir.join("libclaudette_platform_speech.a");
    let sdk_path = command_stdout("xcrun", &["--sdk", "macosx", "--show-sdk-path"]);
    let target = swift_target();

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-O",
            "-emit-library",
            "-static",
        ])
        .args(["-sdk", sdk_path.trim()])
        .args(["-target", &target])
        .arg(&source)
        .arg("-o")
        .arg(&library)
        .status()
        .expect("failed to invoke swiftc for PlatformSpeech.swift");
    assert!(status.success(), "swiftc failed for PlatformSpeech.swift");

    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!(
        "cargo:rustc-link-search=native={}",
        swift_runtime_path().display()
    );
    println!(
        "cargo:rustc-link-search=framework={}/System/Library/Frameworks",
        sdk_path.trim()
    );
    println!("cargo:rustc-link-lib=static=claudette_platform_speech");
    println!("cargo:rustc-link-lib=framework=Speech");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=Foundation");
}

#[cfg(target_os = "macos")]
fn swift_target() -> String {
    let target = env::var("TARGET").expect("target triple");
    let arch = if target.starts_with("aarch64") {
        "arm64"
    } else if target.starts_with("x86_64") {
        "x86_64"
    } else {
        panic!("unsupported macOS target for Swift bridge: {target}");
    };
    format!("{arch}-apple-macosx11.0")
}

#[cfg(target_os = "macos")]
fn command_stdout(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .args(args)
        .output()
        .unwrap_or_else(|err| panic!("failed to run {program}: {err}"));
    assert!(
        output.status.success(),
        "{program} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("utf8 command output")
}

#[cfg(target_os = "macos")]
fn swift_runtime_path() -> PathBuf {
    let swiftc = PathBuf::from(command_stdout("xcrun", &["--find", "swiftc"]).trim());
    let bin = swiftc.parent().expect("swiftc bin dir");
    let toolchain_usr = bin.parent().expect("Swift toolchain usr dir");
    toolchain_usr.join("lib").join("swift").join("macosx")
}
