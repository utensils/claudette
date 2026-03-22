fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=SDKROOT");

    // On macOS, libiconv lives inside the SDK but isn't always on the default
    // linker search path. Point the linker at the SDK's lib directory.
    // Use CARGO_CFG_TARGET_OS to check the *target* platform (not the host),
    // so this behaves correctly during cross-compilation.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && let Ok(output) = std::process::Command::new("xcrun")
            .args(["--show-sdk-path"])
            .output()
        && output.status.success()
    {
        let sdk_path = String::from_utf8_lossy(&output.stdout);
        let sdk_path = sdk_path.trim();
        println!("cargo:rustc-link-search=native={sdk_path}/usr/lib");
    }
}
