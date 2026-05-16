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

# ---- xdg-desktop-portal ----------------------------------------------
# Tauri 2's `tauri-plugin-dialog` routes "Browse" / file-picker
# calls through `org.freedesktop.portal.FileChooser` over DBus.
# Without a portal daemon + matching backend (xdg-desktop-portal-
# gtk in our XFCE setup), the FileChooser call panics and takes
# the app with it. We start the daemon in the background here
# so by the time Claudette launches the bus name is claimed.
# XDG_CURRENT_DESKTOP nudges the daemon to pick the GTK backend
# over a GNOME one if both happened to be installed.
export XDG_CURRENT_DESKTOP=XFCE
echo "[entrypoint] starting xdg-desktop-portal"
/usr/lib/xdg-desktop-portal >/tmp/xdg-portal.log 2>&1 &
/usr/lib/xdg-desktop-portal-gtk >/tmp/xdg-portal-gtk.log 2>&1 &

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

# ---- Clone the public Claudette repo for an "Open project" demo ---
# /workspace is bind-mounted from the host and its `.git` is a
# pointer back to a host path that doesn't resolve inside the
# container — git ops against /workspace appear broken. We clone
# a real, self-contained copy of the public repo into ~/Projects/
# Claudette so the user has somewhere to point Claudette's "Add
# repo" flow at. `CLONE_BRANCH` lets the user override the branch
# (defaults to main); `SKIP_CLONE=1` opts out entirely for a
# faster boot when re-testing.
projects_dir="${HOME}/Projects"
project_clone="${projects_dir}/Claudette"
clone_branch="${CLONE_BRANCH:-main}"
if [ "${SKIP_CLONE:-0}" != "1" ] && [ ! -d "${project_clone}/.git" ]; then
  echo "[entrypoint] cloning utensils/claudette into ${project_clone} (branch ${clone_branch})"
  mkdir -p "${projects_dir}"
  # `--filter=blob:none` keeps history but defers blob fetches —
  # ~10 MB instead of ~150 MB, still enough for Claudette's git
  # features to behave normally. Blobs hydrate on first checkout.
  if git clone --filter=blob:none --branch "${clone_branch}" \
       https://github.com/utensils/claudette.git "${project_clone}" \
       >/tmp/clone.log 2>&1; then
    echo "[entrypoint] clone complete: ${project_clone}"
  else
    echo "[entrypoint] clone FAILED — see /tmp/clone.log" >&2
  fi
fi

# Drop a Thunar launcher on the Desktop so the user can browse
# ~/Projects from the file manager without hunting through the
# panel menu. .desktop files with Type=Link can target a path
# directly — xfdesktop opens it with the default file handler
# (Thunar in our setup).
projects_launcher="${HOME}/Desktop/Projects.desktop"
if [ ! -f "${projects_launcher}" ]; then
  cat > "${projects_launcher}" <<EOF
[Desktop Entry]
Type=Application
Name=Projects
Comment=Open ~/Projects in the file manager
Exec=thunar ${projects_dir}
Icon=folder
Terminal=false
EOF
  chmod +x "${projects_launcher}"
  gio set "${projects_launcher}" "metadata::trusted" true 2>/dev/null || true
fi

# ---- Claudette Dev launcher ----------------------------------------
# Runs `scripts/dev.sh` against the cloned ~/Projects/Claudette
# tree — hot-reloading Tauri dev server. We open it inside an
# xfce4-terminal so the user sees Vite output + Rust compile
# progress; `exec bash` after the dev command keeps the window
# alive if the dev server exits (so they can read the error).
#
# `CARGO_TAURI_FEATURES` drops `voice` from the default set
# because the container has no working ALSA — the voice crate
# would compile fine but cpal::default_host() fails at runtime,
# emitting noisy ALSA warnings. devtools + server + alt-backends
# are kept; everything else inherits from dev.sh defaults.
#
# First click: cold cargo build of the full workspace, ~10-20 min
# under Rosetta. Subsequent clicks: warm rebuild + hot reload.
dev_launcher="${HOME}/Desktop/Claudette Dev.desktop"
if [ ! -f "${dev_launcher}" ]; then
  cat > "${dev_launcher}" <<EOF
[Desktop Entry]
Type=Application
Name=Claudette Dev
Comment=Hot-reloading dev mode against ~/Projects/Claudette
Exec=xfce4-terminal --title=Claudette\\ Dev --working-directory=${project_clone} --hold --command "bash -lc 'export CARGO_TAURI_FEATURES=devtools,server,alternative-backends; ./scripts/dev.sh'"
Icon=applications-development
Terminal=false
EOF
  chmod +x "${dev_launcher}"
  gio set "${dev_launcher}" "metadata::trusted" true 2>/dev/null || true
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
