#!/usr/bin/env bash
# Drive the local AUR PKGBUILD smoke-test container.
#
# Usage:
#   scripts/aur/test-in-docker.sh                   # boot, no auto-build
#   scripts/aur/test-in-docker.sh claudette-bin     # auto-build + install
#   scripts/aur/test-in-docker.sh claudette --launch
#   scripts/aur/test-in-docker.sh --rebuild         # force image rebuild
#
# Then open http://localhost:6080/vnc.html in a browser and click
# "Connect" (no password). The container's /workspace is your repo
# checkout — edit PKGBUILDs locally, the container sees the change
# on next makepkg.
set -euo pipefail

IMAGE="claudette-aur-test"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOCKERFILE="${REPO_ROOT}/packaging/aur/test/Dockerfile"
PORT="${CLAUDETTE_AUR_TEST_PORT:-6080}"
GEOMETRY="${CLAUDETTE_AUR_TEST_GEOMETRY:-1280x800}"

# Choose the container runtime — docker or podman. Podman is the
# Arch-default and Linux contributors are likely to have it; docker
# is the macOS default. `command -v` picks whichever is present.
runtime=""
for candidate in docker podman; do
  if command -v "$candidate" >/dev/null 2>&1; then
    runtime="$candidate"
    break
  fi
done
if [ -z "$runtime" ]; then
  echo "error: neither docker nor podman is on PATH" >&2
  exit 1
fi

pkgname=""
launch=false
rebuild=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --rebuild) rebuild=true ;;
    --launch)  launch=true ;;
    -h|--help)
      sed -n '2,15p' "$0" >&2
      exit 0
      ;;
    claudette-bin|claudette|claudette-git)
      pkgname="$1"
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 64
      ;;
  esac
  shift
done

# (Re)build the image if asked or if it's missing. Cached layers
# make subsequent runs nearly instant — the slow path is the first
# pacman -Syu which pulls webkit2gtk-4.1 + the Rust toolchain.
if "$rebuild" || ! "$runtime" image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> building $IMAGE via $runtime"
  "$runtime" build -t "$IMAGE" -f "$DOCKERFILE" "${REPO_ROOT}/packaging/aur/test"
fi

# Compose env-var flags so the entrypoint knows what to do.
env_flags=( -e "VNC_GEOMETRY=${GEOMETRY}" )
if [ -n "$pkgname" ]; then
  env_flags+=( -e "BUILD_PKG=${pkgname}" )
fi
if "$launch"; then
  # GUI auto-launch only makes sense when there's a build to consume.
  if [ -z "$pkgname" ]; then
    echo "error: --launch requires a PKGBUILD argument" >&2
    exit 64
  fi
  env_flags+=( -e "LAUNCH_CMD=claudette-app" )
fi

echo "==> starting container — open http://localhost:${PORT}/vnc.html when ready"
echo "    (Ctrl-C here to stop. /workspace is bind-mounted read-write from the host.)"

# `--rm` so we don't accumulate stopped containers between runs.
# `--init` reaps the various background processes the entrypoint
# spawns (Xvnc, openbox, websockify, makepkg). On podman --init is
# `--init` too; identical flag.
exec "$runtime" run --rm -it --init \
  --name "claudette-aur-test-$$" \
  -p "${PORT}:6080" \
  -v "${REPO_ROOT}:/workspace:rw" \
  "${env_flags[@]}" \
  "$IMAGE"
