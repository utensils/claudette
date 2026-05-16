# Arch User Repository (AUR) packaging

Claudette is published to the AUR as three packages:

| Package | Source | Update cadence | Audience |
|---|---|---|---|
| [`claudette-bin`](./claudette-bin/PKGBUILD) | Repackages the upstream `.deb` from GitHub Releases | Every tagged release (automatic via CI) | Most users — fastest install, no compile |
| [`claudette`](./claudette/PKGBUILD) | Builds from the release tarball | Every tagged release (automatic via CI) | Users who want a from-source build matching their toolchain |
| [`claudette-git`](./claudette-git/PKGBUILD) | Builds from `main` HEAD | Pushed manually when the build recipe changes | Bleeding-edge users tracking `main` |

The PKGBUILDs here are the source of truth. The AUR git repos
(`ssh://aur@aur.archlinux.org/<pkgname>.git`) are downstream mirrors
that CI force-publishes to on every release.

## Release flow

For each tagged release, `.github/workflows/release-please.yml` runs a
`publish-aur` matrix job (one entry per AUR package, currently
`claudette-bin` and `claudette`). The job:

1. Checks out the tagged commit.
2. Runs [`scripts/aur/update-pkgbuild.sh`](../../scripts/aur/update-pkgbuild.sh)
   which downloads the matching release artifact, computes the
   `sha256sum`, and rewrites `pkgver` + `sha256sums` in the PKGBUILD.
3. Uses [`KSXGitHub/github-actions-deploy-aur`](https://github.com/KSXGitHub/github-actions-deploy-aur)
   to regenerate `.SRCINFO` inside an Arch container, commit, and push
   to the AUR git repo over SSH.

`claudette-git` is **not** auto-published. Its `PKGBUILD` only changes
when the build recipe itself changes (deps, feature flags), so it is
pushed manually whenever someone edits it here.

## One-time setup

The CI job needs an SSH key registered with the AUR account that owns
the packages. To do that:

1. Create the AUR account at https://aur.archlinux.org/ if you don't
   have one yet. Add an SSH public key to your account settings.
2. Generate a deploy keypair on a workstation:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/claudette-aur -C "claudette-aur-ci" -N ""
   ```
3. Add the **public** key (`~/.ssh/claudette-aur.pub`) to the AUR
   account's SSH keys.
4. Add the **private** key (`~/.ssh/claudette-aur`) to this GitHub
   repository as the `AUR_SSH_PRIVATE_KEY` secret
   (Settings → Secrets and variables → Actions).
5. On the AUR side, create empty git repos for each package by
   pushing an initial PKGBUILD from a workstation:
   ```bash
   # for each pkgname in claudette-bin claudette claudette-git
   git clone ssh://aur@aur.archlinux.org/claudette-bin.git
   cp packaging/aur/claudette-bin/PKGBUILD packaging/aur/claudette-bin/.SRCINFO claudette-bin/
   cd claudette-bin && git add . && git commit -m 'Initial upload' && git push
   ```
   After this first push, CI takes over for `claudette-bin` and
   `claudette`.

The `.SRCINFO` regeneration happens inside the Arch container that the
deploy action runs, so contributors editing PKGBUILDs in PRs do not
need `makepkg` installed locally — CI handles it.

## Linux dev / test environment for macOS + Windows contributors

`packaging/aur/test/Dockerfile` doubles as the supported way for
macOS and Windows contributors to verify Linux-specific behavior
without keeping an Arch VM around. It boots an Arch Linux container
with a real XFCE desktop (xfwm4 + xfdesktop + xfce4-panel + thunar)
+ noVNC, builds a chosen PKGBUILD from this repo, installs the
resulting `.pkg.tar.zst`, plants a Claudette launcher on the
Desktop, and clones the public `utensils/claudette` repo into
`~/Projects/Claudette` so you immediately have a project to open.

```bash
# One-command end-to-end (recommended). Builds + installs
# claudette-bin, plants the Desktop icon, drops a project clone
# under ~/Projects/Claudette.
scripts/aur/test-in-docker.sh claudette-bin

# Boot only — no auto-build. Useful when you've already verified
# the build and just want a Linux shell with the repo mounted at
# /workspace.
scripts/aur/test-in-docker.sh

# Same as the first but also auto-launches the GUI on connect.
scripts/aur/test-in-docker.sh claudette-bin --launch

# Force a clean image rebuild (drops the BuildKit layer cache).
scripts/aur/test-in-docker.sh --rebuild
```

Then open `http://localhost:6080/` in any browser and click
**Connect** — no password on noVNC. The XFCE desktop will have:

- A **Claudette** icon (double-click to launch the app)
- A **Projects** icon (opens Thunar at `~/Projects`; the cloned
  Claudette repo is one folder down at `Projects/Claudette/`,
  ready to add as a workspace from inside the app)
- The standard XFCE panel with the application menu, taskbar,
  and notification area

If the OS prompts for a user password (e.g. polkit on a Shutdown
action from the panel menu), the user is `builder` with password
`builder`. Sudo from xfce4-terminal is passwordless.

Container security shape: Xvnc runs with `-localhost yes` and
`-SecurityTypes None`, so only `websockify` on `:6080` is
reachable. The container boundary is the only auth — fine for a
local dev image, never expose port 6080 on a host you don't own.

The script picks `docker` or `podman` based on which is on
`$PATH`. First build downloads ~2 GB (Arch base + Tauri toolchain
+ XFCE), takes 2–3 minutes on a decent connection. Subsequent
runs reuse the cached image instantly; entrypoint-only changes
(the COPY layer) rebuild in seconds.

Env vars you can pass through the helper script:

| Var | Default | Purpose |
|-----|---------|---------|
| `BUILD_PKG` | unset | Which PKGBUILD to build + install on boot. Set by the positional arg. |
| `LAUNCH_CMD` | unset | Command to auto-launch after install. `--launch` sets this to `claudette-app`. |
| `VNC_GEOMETRY` | `1440x900` | xrandr-style geometry. Set via `CLAUDETTE_AUR_TEST_GEOMETRY`. |
| `CLONE_BRANCH` | `main` | Branch to clone into `~/Projects/Claudette`. |
| `SKIP_CLONE` | `0` | Set to `1` to skip the project clone for a faster boot. |
| `CLAUDETTE_AUR_TEST_PORT` | `6080` | Host port to publish noVNC on. |

## Editing a PKGBUILD locally

If you have `makepkg` available (Arch host, or `docker run --rm -it
archlinux:latest`):

```bash
cd packaging/aur/claudette-bin
# After editing PKGBUILD:
makepkg --printsrcinfo > .SRCINFO
makepkg -sci   # build + install locally to smoke-test
```

If you don't have `makepkg`, just edit the PKGBUILD — CI will refresh
`.SRCINFO` for you and the AUR will reject the push if anything is
malformed, so mistakes surface quickly.

## Tauri updater interaction

Claudette ships a Tauri auto-updater that pulls signed builds from the
GitHub release feed. On Linux the updater only activates when the
running binary lives inside an `.AppImage` (currently unshipped — see
[#825](https://github.com/utensils/Claudette/issues/825)). A
pacman-installed binary at `/usr/bin/claudette-app` cannot self-update
either way (the filesystem is root-owned), so the updater silently
no-ops on AUR installs. This is intentional — pacman manages updates
for AUR users.
