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

FROM archlinux:latest

# Refresh keyring + base system, then install everything in one
# layer so the resulting image fits one pacman -Syu transaction.
# `archlinux-keyring` is refreshed first because the base image lag
# can leave it out of date enough to fail signature checks on a
# fresh `pacman -Syu`.
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
        # Lightweight desktop: openbox window manager + a panel +
        # a terminal + a file manager + xrandr for the resolution
        # switch the entrypoint does. tint2 is the panel; pcmanfm
        # gives a desktop right-click menu and a usable file mgr.
        xorg-xinit \
        openbox \
        tint2 \
        xterm \
        pcmanfm \
        ttf-dejavu \
        # X server + VNC server + noVNC web bridge
        tigervnc \
        novnc \
        python-websockify \
        # Quality-of-life: a browser to view the rendered app's
        # webview against, plus curl/jq for the AUR RPC
        curl \
        jq && \
    # Trim the pacman cache — ~150 MB of saved tarballs we don't
    # need at runtime
    paccache -rk 0 || true && \
    rm -rf /var/cache/pacman/pkg/*

# makepkg refuses to run as root by design — it shells out to the
# build scripts in PKGBUILDs and chowning kernel-version-pinned
# /tmp paths to UID 0 has bitten more than one user. We make a
# `builder` user with passwordless sudo so the container scripts
# can `pacman -U` the resulting .pkg.tar.zst.
RUN useradd -m -G wheel -s /bin/bash builder && \
    echo "builder ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/00-builder && \
    chmod 0440 /etc/sudoers.d/00-builder

USER builder
WORKDIR /home/builder

# Openbox needs a (minimal) per-user config to start cleanly. We
# autostart a panel + a terminal so the noVNC viewer sees something
# usable immediately on first connect.
RUN mkdir -p ~/.config/openbox && \
    cat > ~/.config/openbox/autostart <<'AUTOSTART' && \
tint2 &
xterm -geometry 120x32+40+40 -e "bash --login" &
AUTOSTART
    true

# Expose the noVNC HTTP port. The raw VNC display (5901) stays
# container-internal — websockify is the only thing we surface.
EXPOSE 6080

COPY --chown=builder:builder entrypoint.sh /home/builder/entrypoint.sh
RUN chmod +x /home/builder/entrypoint.sh

# /workspace is where the helper script mounts the repo. PKGBUILDs
# resolve to /workspace/packaging/aur/<pkgname>/PKGBUILD.
VOLUME ["/workspace"]

CMD ["/home/builder/entrypoint.sh"]
