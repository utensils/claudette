//! Data types for env-provider results.

use std::collections::HashMap;
use std::path::PathBuf;

/// Environment-variable map. A value of `None` signals "unset this
/// variable in the merged env" — matching `direnv export json`'s
/// semantics where direnv uses `null` to unset vars its `.envrc`
/// previously exported.
pub type EnvMap = HashMap<String, Option<String>>;

/// Result of a single env-provider plugin's `export` operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderExport {
    /// Variables the plugin wants applied to subprocesses spawned in
    /// the workspace. `None`-valued entries are unset rather than set.
    pub env: EnvMap,

    /// Paths the plugin watches for re-evaluation. When any of these
    /// paths' mtimes change, the cached export is invalidated and the
    /// plugin is called again on next resolve.
    ///
    /// Providers should include the primary config file(s) they depend
    /// on (`.envrc`, `mise.toml`, `.env`, `flake.lock`, etc.).
    pub watched: Vec<PathBuf>,
}
