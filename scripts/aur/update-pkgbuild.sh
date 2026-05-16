#!/usr/bin/env bash
# Refresh `pkgver` + `sha256sums` in an AUR PKGBUILD against a
# specific upstream release tag. Designed to be called from CI on a
# release-please publish, but also runnable locally for hand-bumping.
#
# Usage:
#   scripts/aur/update-pkgbuild.sh <pkgname> <version>
#
#   <pkgname>  one of: claudette-bin, claudette
#   <version>  the release version without the leading `v` (e.g. 0.24.0)
#
# Side effects:
#   - Mutates packaging/aur/<pkgname>/PKGBUILD in place.
#   - Always resets `pkgrel` to 1 (a new upstream version implies a
#     fresh package release).
#
# Note: this script does NOT regenerate .SRCINFO. The deploy action
# (KSXGitHub/github-actions-deploy-aur) runs `makepkg --printsrcinfo`
# inside an Arch container after this script finishes, which keeps
# the host requirements minimal (no `makepkg` on the GitHub runner).
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <pkgname> <version>" >&2
  exit 64
fi

pkgname="$1"
version="$2"

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
pkgdir="${repo_root}/packaging/aur/${pkgname}"
pkgbuild="${pkgdir}/PKGBUILD"

if [ ! -f "${pkgbuild}" ]; then
  echo "error: ${pkgbuild} does not exist" >&2
  exit 1
fi

# `sha256sum` and `curl` are present on every Ubuntu runner; no need
# to install anything before invoking us.
fetch_sha() {
  local url="$1"
  # `-fL` so curl follows redirects and fails on 404 instead of
  # silently writing an HTML error page that hashes to garbage.
  curl --silent --show-error --fail --location "${url}" \
    | sha256sum \
    | awk '{print $1}'
}

# In-place sed that works on both GNU sed (CI) and BSD sed (local
# macOS hand-bumps). `sed -i ''` is GNU-incompatible and `sed -i` is
# BSD-incompatible, so we always write to a tempfile and rename.
rewrite() {
  local file="$1" pattern="$2"
  local tmp
  tmp="$(mktemp)"
  sed -E "${pattern}" "${file}" > "${tmp}"
  mv "${tmp}" "${file}"
}

case "${pkgname}" in
  claudette-bin)
    base="https://github.com/utensils/Claudette/releases/download/v${version}"
    echo "==> fetching sha256 for amd64 .deb"
    sha_amd64="$(fetch_sha "${base}/Claudette_${version}_amd64.deb")"
    echo "==> fetching sha256 for arm64 .deb"
    sha_arm64="$(fetch_sha "${base}/Claudette_${version}_arm64.deb")"

    rewrite "${pkgbuild}" "s/^pkgver=.*/pkgver=${version}/"
    rewrite "${pkgbuild}" "s/^pkgrel=.*/pkgrel=1/"
    rewrite "${pkgbuild}" "s|^sha256sums_x86_64=.*|sha256sums_x86_64=('${sha_amd64}')|"
    rewrite "${pkgbuild}" "s|^sha256sums_aarch64=.*|sha256sums_aarch64=('${sha_arm64}')|"
    ;;

  claudette)
    src="https://github.com/utensils/Claudette/archive/refs/tags/v${version}.tar.gz"
    echo "==> fetching sha256 for source tarball"
    sha="$(fetch_sha "${src}")"

    rewrite "${pkgbuild}" "s/^pkgver=.*/pkgver=${version}/"
    rewrite "${pkgbuild}" "s/^pkgrel=.*/pkgrel=1/"
    rewrite "${pkgbuild}" "s|^sha256sums=.*|sha256sums=('${sha}')|"
    ;;

  claudette-git)
    # -git packages derive pkgver from `git describe` at build time;
    # the PKGBUILD here only changes when the build recipe changes,
    # so this script intentionally refuses to touch it.
    echo "error: claudette-git is not auto-bumped; edit its PKGBUILD by hand" >&2
    exit 2
    ;;

  *)
    echo "error: unknown pkgname '${pkgname}'" >&2
    exit 64
    ;;
esac

echo "==> ${pkgbuild} updated to v${version}"
