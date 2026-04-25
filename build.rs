//! Build script — emits `cargo:rustc-cfg` flags so env-provider
//! integration tests that require external CLIs (`direnv`, `mise`,
//! `nix`) can compile-out when the tool isn't installed.
//!
//! These flags are **only used by tests** — production code never
//! gates on them. The design is: ship unit tests that exercise detect
//! logic with synthetic filesystems (no CLI needed), plus integration
//! tests that actually invoke the CLI (gated on availability).
//!
//! Rationale: CI hosts may not have direnv/mise/nix; dev machines
//! usually do. We don't want CI to fail just because a tool isn't
//! installed — the unit tests still cover the Lua detect/parse paths.

fn main() {
    // Declare the cfg names we emit so rustc 1.80+ doesn't warn about
    // unknown --cfg values (edition 2024).
    println!("cargo:rustc-check-cfg=cfg(has_direnv)");
    println!("cargo:rustc-check-cfg=cfg(has_mise)");
    println!("cargo:rustc-check-cfg=cfg(has_nix)");

    // Re-run only if PATH changes — we're probing PATH, not any input file.
    println!("cargo:rerun-if-env-changed=PATH");

    for tool in &["direnv", "mise", "nix"] {
        if which::which(tool).is_ok() {
            println!("cargo:rustc-cfg=has_{tool}");
        }
    }
}
