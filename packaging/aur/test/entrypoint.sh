#!/usr/bin/env bash
# Container entrypoint for the AUR test image.
#
# Boots Xvnc on display :1, starts openbox, and exposes the desktop
# over noVNC on :6080. If $BUILD_PKG is set to one of the AUR pkgnames
# we ship, the script also runs `makepkg -si --noconfirm` on it so
# the connecting user sees a desktop with Claudette already installed
# and ready to launch from xterm.
#
# Env vars:
#   BUILD_PKG       Optional. claudette-bin | claudette | claudette-git
#   VNC_GEOMETRY    Optional. Default 1280x800. Anything xrandr can parse.
#   LAUNCH_CMD      Optional. Command to run after a successful build,
#                   e.g. `claudette-app` to autostart the GUI.
set -euo pipefail

export DISPLAY=:1
GEOMETRY="${VNC_GEOMETRY:-1280x800}"

# ---- VNC + noVNC ----------------------------------------------------
# `-SecurityTypes None` is the explicit "no password" knob. We bind
# Xvnc to localhost so the only reachable surface is websockify on
# 6080 (which we EXPOSE in the Dockerfile). The container's network
# boundary becomes the only auth — fine for a local dev image, never
# do this on a public-facing host.
echo "[entrypoint] starting Xvnc :1 @ ${GEOMETRY}"
Xvnc :1 \
  -SecurityTypes None \
  -geometry "${GEOMETRY}" \
  -depth 24 \
  -localhost yes \
  -AlwaysShared \
  -NeverShared=0 \
  >/tmp/Xvnc.log 2>&1 &

# Wait until Xvnc is actually listening before launching openbox —
# a racing openbox dies with "cannot open display".
for _ in $(seq 1 30); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then break; fi
  sleep 0.2
done

echo "[entrypoint] starting openbox session"
openbox-session >/tmp/openbox.log 2>&1 &

echo "[entrypoint] starting noVNC websockify on :6080"
websockify --web=/usr/share/novnc 6080 localhost:5901 \
  >/tmp/websockify.log 2>&1 &

# ---- Optional PKGBUILD build + install ------------------------------
if [ -n "${BUILD_PKG:-}" ]; then
  pkgdir="/workspace/packaging/aur/${BUILD_PKG}"
  if [ ! -f "${pkgdir}/PKGBUILD" ]; then
    echo "[entrypoint] ERROR: ${pkgdir}/PKGBUILD not found — is /workspace mounted?" >&2
  else
    echo "[entrypoint] building ${BUILD_PKG} from ${pkgdir}"
    # makepkg writes its work dirs into pkgdir; copy out to /tmp so
    # we never mutate the host repo on a bind mount.
    workdir="$(mktemp -d)"
    cp -a "${pkgdir}/." "${workdir}/"
    cd "${workdir}"
    # `-s` resolves dependencies via pacman; `-i` installs the
    # resulting package; `--noconfirm` keeps us non-interactive.
    # `--needed` skips re-installing matching versions of build deps.
    if makepkg -si --noconfirm --needed; then
      echo "[entrypoint] ${BUILD_PKG} installed successfully"
    else
      echo "[entrypoint] ${BUILD_PKG} build FAILED — see scrollback" >&2
    fi
  fi
fi

if [ -n "${LAUNCH_CMD:-}" ]; then
  echo "[entrypoint] launching '${LAUNCH_CMD}' on display ${DISPLAY}"
  # Detach so we don't block the wait-for-foreground below.
  ( setsid bash -lc "${LAUNCH_CMD}" >/tmp/launch.log 2>&1 & )
fi

echo "[entrypoint] ready — open http://localhost:6080/vnc.html in a browser"
echo "[entrypoint] (no password; the 'Connect' button is sufficient)"

# Tail the noVNC log so `docker logs` shows incoming connections
# and we keep PID 1 alive for the container's lifetime.
tail -F /tmp/Xvnc.log /tmp/openbox.log /tmp/websockify.log /tmp/launch.log 2>/dev/null
