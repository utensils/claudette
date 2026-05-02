//! Community registry — discovery and installation of third-party
//! themes, plugins, and grammars from `utensils/claudette-community`.
//!
//! This module ships **only the pure logic** (types, content
//! verification, tarball extraction, install metadata). Network I/O
//! lives in `claudette-tauri` per the existing dep split — the lib
//! crate stays free of `reqwest`. Callers download the tarball and
//! pass bytes to [`install::install`].
//!
//! See [TDD #567](https://github.com/utensils/Claudette/issues/567)
//! for the complete design and roadmap.

pub mod install;
pub mod types;
pub mod verify;

pub use install::{
    InstallError, InstallPlan, InstallRoots, install, read_install_meta, uninstall,
    update_granted_capabilities,
};
pub use types::{
    ColorScheme, ContributionKind, ContributionRef, ContributionSource, InstallSource,
    InstalledMeta, PluginEntry, PluginKindWire, PluginsByKind, Registry, RegistrySource,
    ThemeEntry,
};
pub use verify::{VerifyError, content_hash, verify};
