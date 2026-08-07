//! Unit tests for the bundled SCM Lua plugins.
//!
//! Mirrors `crate::env_provider::plugin_tests`: each plugin's `init.lua` is
//! loaded into a sandboxed Lua VM and its operations are invoked directly,
//! with `host.exec` stubbed to return canned `gh` / `glab` JSON. No external
//! CLI is required.
//!
//! Loading the source at all is half the value — before this file, a syntax
//! error in a bundled SCM plugin compiled fine and only surfaced at runtime
//! as a plugin-load failure. The rest pins the `merged_at` mapping that
//! `crate::scm::auto_archive` depends on to tell a workspace's own merge from
//! one it inherited through a branch-name collision.

use mlua::{Lua, LuaSerdeExt};

use crate::plugin_runtime::host_api::{HostContext, WorkspaceInfo, create_lua_vm};
use crate::plugin_runtime::manifest::PluginKind;
use crate::scm::types::{PrState, PullRequest};

const GITHUB_SRC: &str = include_str!("../../plugins/scm-github/init.lua");
const GITLAB_SRC: &str = include_str!("../../plugins/scm-gitlab/init.lua");

/// Build a VM for an SCM plugin with `host.exec` replaced by a stub that
/// always returns `stdout` and a zero exit code.
fn vm_with_stubbed_exec(plugin: &str, cli: &str, stdout: &str) -> Lua {
    let ctx = HostContext {
        plugin_name: plugin.to_string(),
        kind: PluginKind::Scm,
        allowed_clis: vec![cli.to_string()],
        workspace_info: WorkspaceInfo {
            id: "ws-1".into(),
            name: "test".into(),
            branch: "doomspork/fix-insights-rendering".into(),
            ..Default::default()
        },
        ..Default::default()
    };
    let lua = create_lua_vm(ctx).expect("create vm");
    // Long-bracket string so the canned JSON needs no escaping.
    let stub = format!(
        r#"
        host.exec = function(cmd, args)
            return {{ code = 0, stdout = [==[{stdout}]==], stderr = "" }}
        end
        "#
    );
    lua.load(&stub).exec().expect("install host.exec stub");
    lua
}

/// Invoke `M.<op>(args)` on the plugin source and decode the result as a
/// list of [`PullRequest`], exactly as `PluginRegistry::call_operation`
/// would before handing it to the SCM poller.
fn call_list_prs(plugin: &str, src: &str, cli: &str, stdout: &str) -> Vec<PullRequest> {
    let lua = vm_with_stubbed_exec(plugin, cli, stdout);
    let script = format!(
        r#"
        local M = (function() {src} end)()
        return M.list_pull_requests({{ branch = "doomspork/fix-insights-rendering" }})
        "#
    );
    let value: mlua::Value = lua.load(&script).eval().expect("list_pull_requests call");
    let json: serde_json::Value = lua.from_value(value).expect("lua -> json");
    serde_json::from_value(json).expect("json -> Vec<PullRequest>")
}

const GH_PR_LIST: &str = r#"[
    {"number":1016,"title":"Fix insights","state":"MERGED","url":"https://example.test/1016",
     "author":{"login":"doomspork"},"headRefName":"doomspork/fix-insights-rendering",
     "baseRefName":"main","isDraft":false,"statusCheckRollup":[],
     "mergedAt":"2026-08-05T22:54:34Z"},
    {"number":1017,"title":"Still open","state":"OPEN","url":"https://example.test/1017",
     "author":{"login":"doomspork"},"headRefName":"doomspork/other",
     "baseRefName":"main","isDraft":false,"statusCheckRollup":[],
     "mergedAt":null}
]"#;

const GLAB_MR_LIST: &str = r#"[
    {"iid":1016,"title":"Fix insights","state":"merged","web_url":"https://example.test/1016",
     "author":{"username":"doomspork"},"source_branch":"doomspork/fix-insights-rendering",
     "target_branch":"main","draft":false,"merged_at":"2026-08-05T22:54:34Z"},
    {"iid":1017,"title":"Still open","state":"opened","web_url":"https://example.test/1017",
     "author":{"username":"doomspork"},"source_branch":"doomspork/other",
     "target_branch":"main","draft":false,"merged_at":null}
]"#;

#[test]
fn github_list_pull_requests_maps_merged_at() {
    let prs = call_list_prs("scm-github", GITHUB_SRC, "gh", GH_PR_LIST);
    assert_eq!(prs.len(), 2);

    assert_eq!(prs[0].state, PrState::Merged);
    assert_eq!(prs[0].merged_at.as_deref(), Some("2026-08-05T22:54:34Z"));

    // An unmerged PR's `mergedAt` is JSON null; the plugin must leave the
    // key absent so it round-trips to `None` rather than failing to decode.
    assert_eq!(prs[1].state, PrState::Open);
    assert_eq!(prs[1].merged_at, None);
}

#[test]
fn gitlab_list_pull_requests_maps_merged_at() {
    let prs = call_list_prs("scm-gitlab", GITLAB_SRC, "glab", GLAB_MR_LIST);
    assert_eq!(prs.len(), 2);

    assert_eq!(prs[0].state, PrState::Merged);
    assert_eq!(prs[0].merged_at.as_deref(), Some("2026-08-05T22:54:34Z"));

    assert_eq!(prs[1].state, PrState::Open);
    assert_eq!(prs[1].merged_at, None);
}

#[test]
fn github_get_pull_request_maps_merged_at() {
    let stdout = r#"{"number":1016,"title":"Fix insights","state":"MERGED",
        "url":"https://example.test/1016","author":{"login":"doomspork"},
        "headRefName":"doomspork/fix-insights-rendering","baseRefName":"main",
        "isDraft":false,"statusCheckRollup":[],"mergedAt":"2026-08-05T22:54:34Z"}"#;
    let lua = vm_with_stubbed_exec("scm-github", "gh", stdout);
    let script = format!(
        r#"
        local M = (function() {GITHUB_SRC} end)()
        return M.get_pull_request({{ number = 1016 }})
        "#
    );
    let value: mlua::Value = lua.load(&script).eval().expect("get_pull_request call");
    let json: serde_json::Value = lua.from_value(value).expect("lua -> json");
    let pr: PullRequest = serde_json::from_value(json).expect("json -> PullRequest");

    assert_eq!(pr.merged_at.as_deref(), Some("2026-08-05T22:54:34Z"));
}

/// End-to-end over the seam this change exists to close: a merged PR
/// resolved for a branch the workspace only just adopted must not archive
/// it, while the same PR merged after creation must.
#[test]
fn merged_at_from_the_github_plugin_drives_the_auto_archive_gate() {
    use crate::scm::auto_archive::{AutoArchiveVerdict, evaluate};

    let prs = call_list_prs("scm-github", GITHUB_SRC, "gh", GH_PR_LIST);
    let merged = &prs[0];

    assert_eq!(
        evaluate(merged, "2026-08-07 17:06:00", None),
        AutoArchiveVerdict::PrPredatesWorkspace
    );
    assert_eq!(
        evaluate(merged, "2026-08-04 09:00:00", None),
        AutoArchiveVerdict::Archive
    );
}
