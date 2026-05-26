// Desktop fallback entry point. On iOS/Android the `tauri::mobile_entry_point`
// macro in lib.rs generates the platform shell, so this `main` is only
// reached for `cargo tauri dev` style invocations on macOS/Linux/Windows
// (useful for fast iteration on the chat UI before deploying to a phone).
fn main() {
    claudette_mobile_lib::run();
}
