#!/usr/bin/env bash
# Container entrypoint for the AUR test image.
#
# Boots Xvnc on display :1, runs the optional makepkg build, plants
# a Claudette launcher on the XFCE desktop, then starts xfce4-session.
# noVNC bridges the display to a websocket on port 6080 — open
# http://localhost:6080/ in a browser to see the desktop.
#
# Env vars:
#   BUILD_PKG       Optional. claudette-bin | claudette | claudette-git
#                   When set, the entrypoint builds + installs the
#                   PKGBUILD from /workspace/packaging/aur/<pkgname>/
#                   before starting the desktop session.
#   VNC_GEOMETRY    Optional. Default 1440x900. Anything xrandr can parse.
#   LAUNCH_CMD      Optional. Command to run after a successful build,
#                   e.g. `claudette-app` to autostart the GUI. By
#                   default the user double-clicks the Desktop icon.
set -euo pipefail

export DISPLAY=:1
GEOMETRY="${VNC_GEOMETRY:-1440x900}"

# ---- DBus session ---------------------------------------------------
# libayatana-appindicator (and the rest of XFCE's tray/menu stack)
# wants a session bus. dbus-launch starts one for our session and
# exports DBUS_SESSION_BUS_ADDRESS so children inherit it. Without
# this, Claudette logs "Unable to get session bus" warnings and
# the system tray icon is inert.
echo "[entrypoint] starting dbus session bus"
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

# `machine-id` is required by libdbus's session lookup. The Arch
# package's post-install hook normally writes one, but in the
# container the hook never runs, so we synthesize one. Persisted
# only for the container's lifetime.
if [ ! -s /var/lib/dbus/machine-id ] && [ ! -s /etc/machine-id ]; then
  sudo dbus-uuidgen --ensure=/etc/machine-id
fi

# ---- VNC + noVNC ----------------------------------------------------
# `-SecurityTypes None` is the explicit "no password" knob. Xvnc binds
# to localhost so the only reachable surface is websockify on 6080
# (EXPOSEd in the Dockerfile). Container's network boundary is the
# only auth — fine for a local dev image, never expose this publicly.
echo "[entrypoint] starting Xvnc :1 @ ${GEOMETRY}"
Xvnc :1 \
  -SecurityTypes None \
  -geometry "${GEOMETRY}" \
  -depth 24 \
  -localhost yes \
  -AlwaysShared \
  >/tmp/Xvnc.log 2>&1 &

for _ in $(seq 1 30); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then break; fi
  sleep 0.2
done

echo "[entrypoint] starting noVNC websockify on :6080"
websockify --web=/usr/share/novnc 6080 localhost:5901 \
  >/tmp/websockify.log 2>&1 &

# ---- Optional PKGBUILD build + install ------------------------------
# Done BEFORE xfce starts so xfdesktop sees the freshly-installed
# /usr/share/applications/*.desktop on its first scan, and so the
# user-facing Desktop launcher exists by the time the session boots.
if [ -n "${BUILD_PKG:-}" ]; then
  pkgdir="/workspace/packaging/aur/${BUILD_PKG}"
  if [ ! -f "${pkgdir}/PKGBUILD" ]; then
    echo "[entrypoint] ERROR: ${pkgdir}/PKGBUILD not found — is /workspace mounted?" >&2
  else
    echo "[entrypoint] building ${BUILD_PKG} from ${pkgdir}"
    workdir="$(mktemp -d)"
    cp -a "${pkgdir}/." "${workdir}/"
    cd "${workdir}"
    if makepkg -si --noconfirm --needed; then
      echo "[entrypoint] ${BUILD_PKG} installed"
    else
      echo "[entrypoint] ${BUILD_PKG} build FAILED — see scrollback" >&2
    fi
    cd - >/dev/null
  fi
fi

# ---- Plant a Desktop launcher --------------------------------------
# The .deb the PKGBUILD repacks ships /usr/share/applications/
# Claudette.desktop. Copy it to ~/Desktop so xfdesktop renders an
# icon the user can double-click. `chmod +x` + `gio set` mark it
# trusted on GNOME/GIO-flavored stacks; on XFCE the chmod is what
# actually matters but the gio call is harmless on systems where
# it's a no-op.
desktop_src="/usr/share/applications/Claudette.desktop"
desktop_dst="${HOME}/Desktop/Claudette.desktop"
if [ -f "${desktop_src}" ]; then
  echo "[entrypoint] planting Desktop launcher: ${desktop_dst}"
  cp "${desktop_src}" "${desktop_dst}"
  chmod +x "${desktop_dst}"
  gio set "${desktop_dst}" "metadata::trusted" true 2>/dev/null || true
fi

# ---- Optional auto-launch ------------------------------------------
if [ -n "${LAUNCH_CMD:-}" ]; then
  echo "[entrypoint] auto-launching '${LAUNCH_CMD}' on display ${DISPLAY}"
  ( setsid bash -lc "${LAUNCH_CMD}" >/tmp/launch.log 2>&1 & )
fi

# ---- XFCE session ---------------------------------------------------
# `startxfce4` is the canonical entry point. We background it so
# we can tail logs in the foreground and keep PID 1 alive.
echo "[entrypoint] starting XFCE session"
startxfce4 >/tmp/xfce.log 2>&1 &

echo "[entrypoint] ready — open http://localhost:6080/ in a browser"
echo "[entrypoint] (no password; click 'Connect' and double-click the Claudette icon)"

tail -F /tmp/Xvnc.log /tmp/websockify.log /tmp/xfce.log /tmp/launch.log 2>/dev/null
