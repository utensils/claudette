pub(crate) mod attachments;
mod clipboard;
pub(crate) mod listing;
mod platform;
mod trash;
pub(crate) mod types;
pub(crate) mod watcher;
pub(crate) mod workspace_ops;

pub use types::FileContent;

#[cfg(test)]
mod tests;
