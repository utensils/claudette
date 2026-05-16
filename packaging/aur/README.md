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

## Smoke-testing in Docker (any host OS)

A reproducible Arch Linux build environment with a lightweight desktop
+ noVNC lives in `packaging/aur/test/Dockerfile`. The desktop renders
in your browser, so you can build a PKGBUILD with `makepkg`, install
the resulting `.pkg.tar.zst`, and launch Claudette without needing an
Arch host. The driver script does the build, mount, and port forward
in one step:

```bash
# Boot the container, no auto-build — drop you at a desktop with
# /workspace already pointed at this repo.
scripts/aur/test-in-docker.sh

# Build + install claudette-bin from the local PKGBUILD, then leave
# you at the desktop so you can launch `claudette-app` by hand.
scripts/aur/test-in-docker.sh claudette-bin

# Build + install + auto-launch the GUI in noVNC.
scripts/aur/test-in-docker.sh claudette-bin --launch
```

Then open `http://localhost:6080/vnc.html` in any browser and click
**Connect** — there is no password. The container is local-only
(`-localhost yes` on Xvnc; only `websockify` on 6080 is exposed), so
this auth shape is fine for a dev image but should never be used on a
host you don't own.

The script picks `docker` or `podman` based on whichever is on
`$PATH`. On a fresh box the first build downloads the full Arch
base + Tauri toolchain (~2 GB across `webkit2gtk-4.1`, `rust`,
`bun`, etc.); subsequent runs reuse the cached image instantly.

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
