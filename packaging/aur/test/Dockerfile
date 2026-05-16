# Local AUR PKGBUILD smoke-test environment.
#
# Boots an Arch Linux container running openbox under tigervnc, with
# noVNC bridging the VNC display to a websocket on port 6080. Open
# http://localhost:6080/vnc.html in a browser to see the desktop.
#
# Why this exists: Claudette is a GUI app. A headless Arch container
# tells us whether `makepkg` succeeds, but not whether the resulting
# .pkg.tar.zst actually launches and renders. This image lets us
# install the local PKGBUILD with pacman and click around in noVNC
# before any of it touches the real AUR.
#
# Build:
#   docker build -t claudette-aur-test packaging/aur/test
#
# Drive via the helper in scripts/aur/test-in-docker.sh — see that
# script for argument handling and the workspace mount.

# The official `archlinux:latest` image is x86_64-only on Docker
# Hub — Arch upstream doesn't publish aarch64 manifests there
# (ARM Arch lives as Arch Linux ARM, a separate distro). Pinning
# `linux/amd64` lets the image run under emulation on Apple Silicon
# (OrbStack uses Rosetta; plain Docker Desktop uses qemu-user). The
# overhead is real but acceptable for PKGBUILD smoke-testing, and
# the AUR user base is overwhelmingly x86_64 anyway. On a native
# x86_64 host this line is a no-op.
FROM --platform=linux/amd64 archlinux:latest

# pacman 6.1+ ships an internal seccomp-based sandbox that runs
# downloads as user `alpm`. Under Rosetta / qemu-user emulation
# the seccomp filter syscalls return EINVAL ("error restricting
# syscalls via seccomp: 22") and every sync fails. Disabling the
# sandbox up front is the documented escape hatch for emulated
# Arch containers — safe here because the container is
# single-user and the build is the only thing running.
RUN printf '\nDisableSandbox\n' >> /etc/pacman.conf

# Initialize pacman-key's local keyring + import the Arch master
# keys before any package install. Without this step,
# `archlinux-keyring`'s post-install hook tries to verify its own
# signatures against a missing trustdb and emits "There is no
# secret key available to sign with" — non-fatal but noisy.
RUN pacman-key --init && pacman-key --populate archlinux

# Refresh keyring + base system, then install everything in one
# layer so the resulting image fits one pacman -Syu transaction.
# Note: noVNC + websockify are *not* in the official repos
# (extra/core) — only in the AUR. Rather than bootstrap two
# unrelated AUR builds inside the test image whose whole point is
# to test *our* PKGBUILDs, we pull websockify from pip and noVNC
# as a static git checkout below.
RUN pacman -Sy --noconfirm archlinux-keyring && \
    pacman -Syu --noconfirm \
        # makepkg + the standard build group
        base-devel \
        git \
        sudo \
        # Tauri 2 runtime deps (mirrors PKGBUILD `depends`) — keeps
        # `pacman -U` of our built .pkg.tar.zst from re-resolving
        # the whole tree at install time
        webkit2gtk-4.1 \
        gtk3 \
        libsoup3 \
        libayatana-appindicator \
        librsvg \
        alsa-lib \
        openssl \
        # Source-build toolchain (claudette + claudette-git
        # PKGBUILDs need these even if the user is only testing
        # claudette-bin — pre-baking keeps iteration fast)
        rust \
        cargo \
        bun \
        pkgconf \
        patchelf \
        # XFCE desktop: xfwm4 (WM) + xfdesktop (desktop with
        # right-click menu + .desktop icon launcher) + xfce4-panel
        # (taskbar + app menu) + thunar (file browser) + xfce4-
        # session (manages startup). xfce4-goodies pulls in
        # xfce4-terminal, xfce4-taskmanager, xfce4-screenshooter
        # — useful when poking at a freshly-installed Claudette.
        # dbus is added explicitly so libayatana-appindicator and
        # the rest of the tray surface can attach to the session
        # bus (without it the GUI logs DBus warnings on startup).
        xorg-xinit \
        xfce4 \
        xfce4-goodies \
        dbus \
        ttf-dejavu \
        ttf-liberation \
        # X server + VNC server (no noVNC here — installed below).
        tigervnc \
        # websockify needs python; pulling python-pip from extra so
        # we can pip-install websockify into a venv on the next layer.
        python \
        python-pip \
        # Quality-of-life: curl/jq for the AUR RPC + ad-hoc HTTP
        curl \
        jq && \
    { command -v paccache >/dev/null && paccache -rk 0; true; } && \
    rm -rf /var/cache/pacman/pkg/*

# noVNC + websockify (both AUR-only on Arch). websockify lives in
# its own venv so PEP 668's "externally managed" system Python
# stays untouched. The venv's `websockify` script lands in
# /opt/websockify/bin which we put on PATH for downstream layers
# + the entrypoint.
RUN python -m venv /opt/websockify && \
    /opt/websockify/bin/pip install --no-cache-dir websockify==0.13.0
ENV PATH="/opt/websockify/bin:${PATH}"

# noVNC frontend = static HTML/JS. Pin to a released tag (matches
# the AUR `novnc` package's upstream version) and shallow-clone to
# trim a few hundred MB of git history.
RUN git clone --depth 1 --branch v1.6.0 \
        https://github.com/novnc/noVNC /usr/share/novnc && \
    # noVNC ships its launcher at /utils/novnc_proxy; the standard
    # "open vnc.html" path expects index.html to redirect there.
    # Create a one-line index so http://host:6080/ goes straight
    # to the client without a 404.
    ln -sf vnc.html /usr/share/novnc/index.html

# makepkg refuses to run as root by design — it shells out to the
# build scripts in PKGBUILDs and chowning kernel-version-pinned
# /tmp paths to UID 0 has bitten more than one user. We make a
# `builder` user with passwordless sudo so the container scripts
# can `pacman -U` the resulting .pkg.tar.zst.
#
# The password is "builder" — set rather than left as the default
# locked account because XFCE's polkit agent prompts for the user
# password when actions like "Shutdown" or "Mount" are triggered
# from the panel menu. A locked account can never satisfy that
# prompt, leaving the user stuck. For a throwaway test container
# a memorable password is the right trade-off.
RUN useradd -m -G wheel -s /bin/bash builder && \
    echo "builder:builder" | chpasswd && \
    echo "builder ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/00-builder && \
    chmod 0440 /etc/sudoers.d/00-builder

# Remove the XFCE screensaver + power manager. They're useful on
# real desktops but in a container they only get in the way:
# - xfce4-screensaver locks after 10 min idle, which is the
#   prompt the user just hit. Removing it eliminates the lock
#   entirely instead of trying to disable it from xfconf at
#   first run (which races with xfce4-session startup).
# - xfce4-power-manager surfaces "battery low" warnings and
#   "lid close" handlers that are nonsense in a container.
# `pacman -Rsn` strips them and any orphan deps without
# prompting; --noconfirm + ||true so a missing package doesn't
# fail the build.
RUN pacman -Rsn --noconfirm xfce4-screensaver xfce4-power-manager 2>/dev/null || true

USER builder
WORKDIR /home/builder

# XFCE manages its own session config; we only need an empty
# Desktop dir so xfdesktop has somewhere to drop the Claudette
# launcher icon once the entrypoint plants it post-install.
RUN mkdir -p /home/builder/Desktop /home/builder/.config/autostart

# Expose the noVNC HTTP port. The raw VNC display (5901) stays
# container-internal — websockify is the only thing we surface.
EXPOSE 6080

COPY --chown=builder:builder entrypoint.sh /home/builder/entrypoint.sh
RUN chmod +x /home/builder/entrypoint.sh

# /workspace is where the helper script mounts the repo. PKGBUILDs
# resolve to /workspace/packaging/aur/<pkgname>/PKGBUILD.
VOLUME ["/workspace"]

CMD ["/home/builder/entrypoint.sh"]
