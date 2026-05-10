//! End-to-end exercise of the granted_capabilities enforcement flow
//! introduced for issue #580. Walks the full path a user takes:
//!
//!   1. Install a community plugin via the registry installer.
//!   2. Discover it through `PluginRegistry::discover` and confirm
//!      `PluginTrust::Community` is resolved with the install-time
//!      grants.
//!   3. Run an operation — succeeds because the manifest's
//!      `required_clis` is a subset of grants.
//!   4. Simulate a malicious / drift manifest update by rewriting
//!      `plugin.json` to declare a new CLI. Re-discover.
//!   5. Run the operation again — fails closed with
//!      `PluginError::NeedsReconsent { missing }`.
//!   6. Approve the new capabilities via
//!      `community::update_granted_capabilities`. Re-discover.
//!   7. Run the operation a third time — succeeds.
//!
//! This is the acceptance criteria #580 calls out, exercised
//! through the same plumbing the live Tauri commands use.

use std::path::Path;

use claudette::community::{
    self, ContributionKind, ContributionSource, InstallPlan, InstallRoots, PluginKindWire,
};
use claudette::plugin_runtime::host_api::WorkspaceInfo;
use claudette::plugin_runtime::{PluginError, PluginRegistry, PluginTrust};
use flate2::Compression;
use flate2::write::GzEncoder;

const PLUGIN_NAME: &str = "scm-fake";

fn make_tarball(prefix: &str, entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut tar_bytes = Vec::new();
    {
        let gz = GzEncoder::new(&mut tar_bytes, Compression::fast());
        let mut builder = tar::Builder::new(gz);
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, format!("{prefix}{path}"), *data)
                .unwrap();
        }
        builder.finish().unwrap();
    }
    tar_bytes
}

fn workspace(dir: &Path) -> WorkspaceInfo {
    WorkspaceInfo {
        id: "ws-1".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: dir.to_string_lossy().into_owned(),
        repo_path: dir.to_string_lossy().into_owned(),
        ..Default::default()
    }
}

#[tokio::test]
async fn community_plugin_capability_lifecycle() {
    let manifest_v1 = serde_json::json!({
        "name": PLUGIN_NAME,
        "display_name": "Fake SCM",
        "version": "1.0.0",
        "description": "Test plugin for grant enforcement",
        // Empty required_clis at install time so the install-time
        // grant is also empty — the grant ⊇ manifest invariant
        // holds trivially. We test the manifest-grew threat model
        // by rewriting plugin.json after install.
        "required_clis": [],
        "operations": ["run"]
    });

    let init_lua = "local M = {}\nfunction M.run(_)\n  return { ok = true }\nend\nreturn M\n";

    let manifest_v1_bytes = manifest_v1.to_string();
    let entries: Vec<(&str, &[u8])> = vec![
        (
            "plugins/scm/scm-fake/plugin.json",
            manifest_v1_bytes.as_bytes(),
        ),
        ("plugins/scm/scm-fake/init.lua", init_lua.as_bytes()),
    ];
    let tarball = make_tarball("repo-root/", &entries);

    // Compute the content hash the same way the installer + verify
    // module does. Extract once into a probe dir.
    let probe = tempfile::tempdir().unwrap();
    {
        // Reach into the lib for the same extraction the installer
        // uses. We can't call `extract_subtree` (private), but
        // installing into a probe dir gives us the verified hash by
        // running the installer twice — so do it differently:
        // hash the staged directory by hand. The verify module is
        // re-exported.
        let plugin_dir = probe.path().join("plugins/scm/scm-fake");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(plugin_dir.join("plugin.json"), manifest_v1_bytes.as_bytes()).unwrap();
        std::fs::write(plugin_dir.join("init.lua"), init_lua).unwrap();
    }

    // The installer's verify is content-hash over the plugin
    // directory only. Compute the same way:
    let staged = probe.path().join("plugins/scm/scm-fake");
    let sha = community::content_hash(&staged).unwrap();

    // Install roots under a fresh tempdir.
    let roots_tmp = tempfile::tempdir().unwrap();
    let roots = InstallRoots {
        plugins_dir: roots_tmp.path().join("plugins"),
        themes_dir: roots_tmp.path().join("themes"),
    };

    // Install the plugin with empty granted_capabilities (mirrors a
    // user clicking install on a plugin whose registry-snapshot
    // required_clis was []).
    let plan = InstallPlan {
        kind: ContributionKind::Plugin(PluginKindWire::Scm),
        ident: PLUGIN_NAME.into(),
        source: ContributionSource::InTree {
            path: "plugins/scm/scm-fake".into(),
            sha: "1".repeat(40),
            sha256: sha.clone(),
        },
        version: "1.0.0".into(),
        granted_capabilities: vec![], // empty grant at install time
        registry_sha: "2".repeat(40),
    };
    let install_path = community::install(&plan, &tarball, &roots).expect("install");
    let installed_meta = community::read_install_meta(&install_path)
        .unwrap()
        .unwrap();
    assert!(
        installed_meta.granted_capabilities.is_empty(),
        "fresh install records empty grants"
    );

    // ---- Step 2: discover --------------------------------------------------
    let registry = PluginRegistry::discover(&roots.plugins_dir);
    let trust = &registry
        .plugins
        .get(PLUGIN_NAME)
        .expect("plugin discovered")
        .trust;
    match trust {
        PluginTrust::Community { granted } => assert!(granted.is_empty()),
        other => panic!("expected Community trust, got {other:?}"),
    }

    // ---- Step 3: op succeeds (manifest required_clis is empty) -------------
    let result = registry
        .call_operation(
            PLUGIN_NAME,
            "run",
            serde_json::json!({}),
            workspace(roots_tmp.path()),
        )
        .await
        .expect("first run must succeed");
    assert_eq!(result["ok"], true);

    // ---- Step 4: simulate manifest drift -----------------------------------
    // A registry update bumps required_clis. We use `cargo` because
    // it is guaranteed to be on PATH whenever this test runs (the
    // test harness needs it to compile in the first place) — that
    // keeps step 7 hermetic, since `cli_available` is probed against
    // PATH at re-discovery.
    let manifest_path = install_path.join("plugin.json");
    let manifest_v2 = serde_json::json!({
        "name": PLUGIN_NAME,
        "display_name": "Fake SCM",
        "version": "1.0.0",
        "description": "Test plugin for grant enforcement",
        "required_clis": ["cargo"],
        "operations": ["run"]
    });
    std::fs::write(&manifest_path, manifest_v2.to_string()).unwrap();

    let registry = PluginRegistry::discover(&roots.plugins_dir);
    // Trust still says Community with empty grants — the
    // .install_meta.json wasn't touched.
    match &registry.plugins[PLUGIN_NAME].trust {
        PluginTrust::Community { granted } => assert!(granted.is_empty()),
        other => panic!("expected Community trust, got {other:?}"),
    }

    // ---- Step 5: op now fails closed with NeedsReconsent -------------------
    let result = registry
        .call_operation(
            PLUGIN_NAME,
            "run",
            serde_json::json!({}),
            workspace(roots_tmp.path()),
        )
        .await;
    match result {
        Err(PluginError::NeedsReconsent { plugin, missing }) => {
            assert_eq!(plugin, PLUGIN_NAME);
            assert_eq!(missing, vec!["cargo".to_string()]);
        }
        other => panic!("expected NeedsReconsent, got {other:?}"),
    }

    // ---- Step 6: user approves the new grants ------------------------------
    community::update_granted_capabilities(&install_path, &["cargo".to_string()])
        .expect("update grants");
    let after_grant = community::read_install_meta(&install_path)
        .unwrap()
        .unwrap();
    assert_eq!(after_grant.granted_capabilities, vec!["cargo".to_string()]);

    // Re-discover to pick up the new grants. (The Tauri command
    // `community_grant_capabilities` does this via
    // `rehydrate_plugin_registry`.)
    let registry = PluginRegistry::discover(&roots.plugins_dir);
    match &registry.plugins[PLUGIN_NAME].trust {
        PluginTrust::Community { granted } => {
            assert_eq!(granted, &vec!["cargo".to_string()]);
        }
        other => panic!("expected Community trust, got {other:?}"),
    }

    // ---- Step 7: op succeeds again -----------------------------------------
    let result = registry
        .call_operation(
            PLUGIN_NAME,
            "run",
            serde_json::json!({}),
            workspace(roots_tmp.path()),
        )
        .await
        .expect("third run must succeed after re-consent");
    assert_eq!(result["ok"], true);
}
