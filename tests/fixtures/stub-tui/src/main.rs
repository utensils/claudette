//! Stub TUI used by interactive_host integration tests.
//!
//! Behavior:
//! - Prints `READY\n` on startup so tests can synchronize.
//! - Reads stdin line-by-line. Each line is echoed back as `OUT: <line>\n`.
//! - If `STUB_TUI_FAKE_AWAITING_AFTER` is set to a positive integer N, after
//!   echoing N lines we exit 0 (simulating `Stop` hook) without further output.
//! - If `STUB_TUI_CRASH_AFTER` is set, panic after that many lines.
//! - Line `quit\n` exits 0 immediately.

use std::io::{BufRead, Write};

fn main() {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "READY").unwrap();
    stdout.flush().unwrap();

    let limit: Option<u32> = std::env::var("STUB_TUI_FAKE_AWAITING_AFTER")
        .ok()
        .and_then(|s| s.parse().ok());
    let crash_after: Option<u32> = std::env::var("STUB_TUI_CRASH_AFTER")
        .ok()
        .and_then(|s| s.parse().ok());

    let stdin = std::io::stdin();
    let mut count: u32 = 0;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line == "quit" {
            return;
        }
        writeln!(stdout, "OUT: {line}").unwrap();
        stdout.flush().unwrap();
        count += 1;
        if let Some(n) = limit
            && count >= n
        {
            return;
        }
        if let Some(n) = crash_after
            && count >= n
        {
            panic!("stub-tui crashing as instructed");
        }
    }
}
