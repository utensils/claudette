//! Repository CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

/// Returns true when `err` is the SQLite `UNIQUE` constraint failure on
/// `repositories.path` — i.e. the caller tried to insert a repo whose path
/// is already registered. Other constraint failures (including UNIQUE on
/// other columns) return false.
pub fn is_duplicate_repository_path_error(err: &rusqlite::Error) -> bool {
    if let rusqlite::Error::SqliteFailure(code, Some(msg)) = err {
        code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
            && msg.contains("repositories.path")
    } else {
        false
    }
}
