//! Library surface of the Claudette session host.
//!
//! The session-host binary owns interactive Claude PTYs and exposes a local
//! socket protocol so the Tauri app (and integration tests) can talk to it
//! out of process. Splitting the crate into a `lib` + `bin` lets tests link
//! against the server directly without spawning the binary.

pub mod idle;
pub mod server;
pub mod session;

/// Re-exported so `server::dispatch` can construct `SessionSummary` instances
/// without spelling out the full `claudette::agent::interactive_protocol` path
/// at every call site.
pub use claudette::agent::interactive_protocol::SessionSummary;
