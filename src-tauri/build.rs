// All Swift-bridge plumbing is macOS-only; gating the imports keeps
// non-macOS builds free of unused-import warnings under `-Dwarnings`.
#[cfg(target_os = "macos")]
use std::env;
#[cfg(target_os = "macos")]
use std::process::Command;

use std::path::{Path, PathBuf};

fn main() {
    generate_bundle_icons();

    #[cfg(target_os = "macos")]
    compile_platform_speech_swift();

    tauri_build::build();
}

// Regenerates the platform-specific bundle icons (`32x32.png`, `128x128.png`,
// `128x128@2x.png`, `icon.icns`, `icon.ico`) from `icons/icon.png`. Only
// `icon.png` is checked into git; the rest are gitignored so contributors don't
// accumulate churn from `cargo tauri icon` re-runs. See issue #516.
fn generate_bundle_icons() {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set during build"),
    );
    let icons_dir = manifest_dir.join("icons");
    let source = icons_dir.join("icon.png");

    println!("cargo:rerun-if-changed={}", source.display());

    let outputs: [(&str, IconKind); 5] = [
        ("32x32.png", IconKind::Png { side: 32 }),
        ("128x128.png", IconKind::Png { side: 128 }),
        ("128x128@2x.png", IconKind::Png { side: 256 }),
        ("icon.icns", IconKind::Icns),
        ("icon.ico", IconKind::Ico),
    ];

    if outputs_are_fresh(&source, &icons_dir, &outputs) {
        return;
    }

    if !source.exists() {
        panic!(
            "icons/icon.png is missing — cannot generate bundle icons. \
             Restore icons/icon.png (the only icon source tracked in git)."
        );
    }

    let img = image::open(&source).unwrap_or_else(|err| {
        panic!("failed to open {}: {err}", source.display());
    });

    for (name, kind) in &outputs {
        let path = icons_dir.join(name);
        match kind {
            IconKind::Png { side } => write_png(&img, *side, &path),
            IconKind::Icns => write_icns(&img, &path),
            IconKind::Ico => write_ico(&img, &path),
        }
    }
}

#[derive(Clone, Copy)]
enum IconKind {
    Png { side: u32 },
    Icns,
    Ico,
}

fn outputs_are_fresh(source: &Path, icons_dir: &Path, outputs: &[(&str, IconKind)]) -> bool {
    let Ok(source_mtime) = std::fs::metadata(source).and_then(|m| m.modified()) else {
        return false;
    };
    outputs.iter().all(|(name, _)| {
        std::fs::metadata(icons_dir.join(name))
            .and_then(|m| m.modified())
            .map(|t| t >= source_mtime)
            .unwrap_or(false)
    })
}

fn write_png(src: &image::DynamicImage, side: u32, out: &Path) {
    let resized = src.resize_exact(side, side, image::imageops::FilterType::Lanczos3);
    resized
        .save(out)
        .unwrap_or_else(|err| panic!("failed to write {}: {err}", out.display()));
}

fn write_icns(src: &image::DynamicImage, out: &Path) {
    use icns::{IconFamily, IconType, Image, PixelFormat};

    // The .icns container holds multiple resolutions; macOS picks the closest match
    // for each render context. RGBA32_*_2x variants encode retina pairs at 2× the
    // logical size (e.g. 256×256 pixel data labeled "128@2x").
    let levels: &[(u32, IconType)] = &[
        (16, IconType::RGBA32_16x16),
        (32, IconType::RGBA32_16x16_2x),
        (32, IconType::RGBA32_32x32),
        (64, IconType::RGBA32_32x32_2x),
        (128, IconType::RGBA32_128x128),
        (256, IconType::RGBA32_128x128_2x),
        (256, IconType::RGBA32_256x256),
        (512, IconType::RGBA32_256x256_2x),
        (512, IconType::RGBA32_512x512),
        (1024, IconType::RGBA32_512x512_2x),
    ];

    let mut family = IconFamily::new();
    for (side, icon_type) in levels {
        let resized = src
            .resize_exact(*side, *side, image::imageops::FilterType::Lanczos3)
            .to_rgba8();
        let image = Image::from_data(PixelFormat::RGBA, *side, *side, resized.into_raw())
            .expect("icns Image::from_data");
        family
            .add_icon_with_type(&image, *icon_type)
            .expect("icns add_icon_with_type");
    }

    let file = std::fs::File::create(out)
        .unwrap_or_else(|err| panic!("failed to create {}: {err}", out.display()));
    family
        .write(file)
        .unwrap_or_else(|err| panic!("failed to write {}: {err}", out.display()));
}

fn write_ico(src: &image::DynamicImage, out: &Path) {
    use ico::{IconDir, IconDirEntry, IconImage, ResourceType};

    let sides: &[u32] = &[16, 24, 32, 48, 64, 128, 256];

    let mut icon_dir = IconDir::new(ResourceType::Icon);
    for side in sides {
        let resized = src
            .resize_exact(*side, *side, image::imageops::FilterType::Lanczos3)
            .to_rgba8();
        let image = IconImage::from_rgba_data(*side, *side, resized.into_raw());
        icon_dir.add_entry(IconDirEntry::encode(&image).expect("ico encode"));
    }

    let file = std::fs::File::create(out)
        .unwrap_or_else(|err| panic!("failed to create {}: {err}", out.display()));
    icon_dir
        .write(file)
        .unwrap_or_else(|err| panic!("failed to write {}: {err}", out.display()));
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
