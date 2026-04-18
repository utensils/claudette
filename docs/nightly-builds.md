# Nightly Builds

Nightly builds are pre-release artifacts automatically built from every push to `main`. They are fully signed and notarized — identical pipeline to stable releases, just more frequent and less tested.

## Version scheme

Nightly versions follow the pattern:

```
<next-minor>-dev.<commits-since-last-release>.<short-sha>
```

For example, if `Cargo.toml` on `main` reads `0.12.0` and there have been 42 commits since the last release tag:

```
0.13.0-dev.42.a1b2c3d
```

This is valid SemVer with pre-release identifiers. It sorts **higher** than `0.12.0` and **lower** than `0.13.0`, which is the correct behavior for the Tauri updater.

> **Note:** Immediately after a release-please version bump (e.g., `0.12.0` → `0.13.0`), the nightly version jumps to `0.14.0-dev.N.SHA`. This is expected — the "next minor" is always one above whatever version is in `Cargo.toml` at build time.

## Download

Nightly artifacts are published to a single rolling GitHub Release:

**<https://github.com/utensils/Claudette/releases/tag/nightly>**

Available artifacts per platform:

| Platform | Artifacts |
|---|---|
| macOS (Apple Silicon) | `.dmg`, `.app.tar.gz` |
| macOS (Intel) | `.dmg`, `.app.tar.gz` |
| Linux (x86_64) | `.AppImage`, `.deb` |

The `claudette-server` headless binary is also available for each platform.

## Updater channel

The default in-app updater checks the **stable** channel (`releases/latest/download/latest.json`). Nightly builds produce their own updater manifest at:

```
https://github.com/utensils/Claudette/releases/download/nightly/latest.json
```

A future update (see [#282](https://github.com/utensils/Claudette/issues/282)) will add an in-app toggle to switch between stable and nightly update channels.

## When they run

- **Automatically** on every push to `main` that changes code (docs-only and site-only changes are skipped).
- **Manually** via `workflow_dispatch` from the GitHub Actions UI.
- Rapid consecutive pushes are coalesced — only the most recent push builds.

## Rolling tag semantics

The `nightly` tag and release are **deleted and recreated** on every successful build. This means:

- The `nightly` tag always points to the most recent successful build.
- Old nightly download URLs will 404 after the next build replaces them.
- To reference a specific nightly build, record the **commit SHA** from the release body — not the tag.

If a build fails mid-way, the previous nightly release is already deleted. Users will see no nightly available until the next successful build. This is expected behavior for a pre-release channel.

## Troubleshooting

**"Old nightly download link returns 404"** — Expected. The rolling tag was updated by a newer build. Use the `nightly` tag URL above to always get the latest.

**"App won't auto-update from nightly to stable"** — Stable and nightly use different updater manifests, and a nightly build may also compare higher than the current stable release (for example, `0.14.0-dev.*` is higher than any `0.13.*` stable). In that case, the stable feed will not appear as an upgrade. To switch back to stable, download and install the stable release manually.

**"Version looks wrong / shows old version"** — The version is computed from the `Cargo.toml` version on `main` at build time. If release-please hasn't merged a version bump yet, the "next minor" component may look stale. The commit SHA in the version string is always accurate.
