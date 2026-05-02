{
  description = "Claudette — cross-platform desktop orchestrator for parallel Claude Code agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";

    devshell.url = "github:numtide/devshell";
    devshell.inputs.nixpkgs.follows = "nixpkgs";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";

    fenix.url = "github:nix-community/fenix";
    fenix.inputs.nixpkgs.follows = "nixpkgs";

    crane.url = "github:ipetkov/crane";
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.devshell.flakeModule
        inputs.treefmt-nix.flakeModule
      ];

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      perSystem =
        {
          pkgs,
          system,
          lib,
          ...
        }:
        let
          fenixPkgs = inputs.fenix.packages.${system};
          rustToolchain = fenixPkgs.combine [
            fenixPkgs.latest.cargo
            fenixPkgs.latest.clippy
            fenixPkgs.latest.llvm-tools-preview
            fenixPkgs.latest.rust-src
            fenixPkgs.latest.rustc
            fenixPkgs.latest.rustfmt
            # Windows MSVC cross-compile targets (consumed via cargo-xwin in
            # the devshell). aarch64 is the priority per project plan;
            # x86_64 included so both Windows architectures are available.
            # rust-std ships the Windows stdlib binaries; the MS CRT and
            # Windows SDK headers are fetched on demand by cargo-xwin.
            fenixPkgs.targets.aarch64-pc-windows-msvc.latest.rust-std
            fenixPkgs.targets.x86_64-pc-windows-msvc.latest.rust-std
          ];

          craneLib = (inputs.crane.mkLib pkgs).overrideToolchain rustToolchain;

          # Version from workspace Cargo.toml — single source of truth
          crateInfo = craneLib.crateNameFromCargoToml { cargoToml = ./Cargo.toml; };
          inherit (crateInfo) version;

          commonMeta = {
            homepage = "https://github.com/utensils/Claudette";
            license = lib.licenses.mit;
            platforms = [
              "x86_64-linux"
              "aarch64-linux"
              "aarch64-darwin"
            ];
          };

          # Frontend: FOD with network access for bun install + vite build.
          # Update the hash when src/ui/bun.lock or package.json change:
          #   nix build .#frontend 2>&1 | grep 'got:' | awk '{print $2}'
          frontend = pkgs.stdenvNoCC.mkDerivation {
            pname = "claudette-frontend";
            inherit version;
            src = ./src/ui;

            # nodejs is only needed on Linux to resolve the
            # `#!/usr/bin/env node` shebangs that bun installs into
            # node_modules — the Nix build sandbox on Linux has no
            # /usr/bin/env, so patchShebangs rewrites them to an absolute
            # store path. macOS's sandbox has /usr/bin/env and the original
            # FOD hash was computed without patching, so keep the old code
            # path there to avoid a pointless hash churn.
            nativeBuildInputs = [
              pkgs.bun
            ]
            ++ lib.optionals pkgs.stdenv.isLinux [
              pkgs.nodejs
            ];

            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            # FOD hashes differ across platforms because vite/tsc can embed
            # platform-specific paths into its sourcemap output, and on
            # Linux we additionally patchShebangs the node_modules tree.
            # Update the relevant branch when src/ui/bun.lock or
            # package.json change:
            #   nix build .#frontend 2>&1 | grep 'got:' | awk '{print $2}'
            outputHash =
              if pkgs.stdenv.isDarwin then
                "sha256-jAvDzhkVASfcc36K4ngTKAWTAus2H7oqaqp1pUXZRFo="
              else
                "sha256-TP3Ck8BOXAZRMo7YPVGvxe9ULewNhdVsUU9x/bpjJL4=";

            buildPhase = ''
              export HOME=$TMPDIR
              bun install --frozen-lockfile
            ''
            + lib.optionalString pkgs.stdenv.isLinux ''
              # Patch the real binary files, not the .bin/ symlinks —
              # patchShebangs doesn't follow symlinks into unrelated paths,
              # and the actual tsc/vite binaries live under their package
              # directories (e.g. node_modules/typescript/bin/tsc).
              patchShebangs node_modules
            ''
            + ''
              bun run build
            '';

            installPhase = ''
              cp -r dist $out
            '';
          };

          # Cargo-only source: Cargo.toml, Cargo.lock, and *.rs files.
          # Used by buildDepsOnly so UI/asset changes don't rebuild deps.
          cargoSrc = craneLib.cleanCargoSource ./.;

          # Full source: Cargo files + src-tauri config + assets (logo for
          # tauri-codegen) + plugins (seeded into the binary via include_str!
          # from src/scm_provider/seed.rs).
          src = lib.cleanSourceWith {
            src = ./.;
            filter =
              path: type:
              (craneLib.filterCargoSources path type)
              || (builtins.match ".*src-tauri/.*" path != null)
              || (builtins.match ".*assets/.*" path != null)
              || (builtins.match ".*plugins/.*" path != null)
              # Migration .sql files are loaded via include_str! in
              # src/migrations/mod.rs, so they must survive the source
              # filter even though they aren't *.rs.
              || (builtins.match ".*/migrations/.*\\.sql" path != null);
          };

          # Platform-specific build dependencies
          darwinBuildInputs = lib.optionals pkgs.stdenv.isDarwin [
            pkgs.apple-sdk_15
            pkgs.libiconv
          ];

          # Wrapper around `clang` that rewrites the MSVC-style `/imsvc`
          # include flag to the GNU-driver-compatible `-isystem` form.
          #
          # cargo-xwin's default (and correct-for-STL) mode is clang-cl: it
          # injects `/imsvc <path>` pairs into CFLAGS_<target> so that clang-cl
          # sees the MSVC CRT + SDK + C++ STL under xwin/crt/include (which
          # actually contains <iterator>, <vector>, ... — the alternative
          # "sysroot" mode ships a sysroot whose include/c++/stl/ directory
          # is empty on aarch64, so clang-cl mode is the only workable one).
          #
          # The snag: `ring`'s build script compiles Windows ARM64 `.S`
          # assembly by invoking `clang` directly (not clang-cl, because
          # clang-cl doesn't parse GAS syntax). The GNU-driver `clang` then
          # rejects `/imsvc` (treated as a filename) and also rejects
          # `-imsvc` (clang-cl-only spelling). The only spelling accepted by
          # both drivers is `-isystem`, which carries the same semantics we
          # need here (mark the directory as a system header root, suppress
          # diagnostics from headers within it).
          #
          # Wrapping `clang` specifically (not clang-cl, not clang++) is
          # sufficient because that is the exact binary ring shells out to
          # for the .S pregenerated files.
          clangXwinShim = pkgs.writeShellScriptBin "clang" ''
            args=()
            for arg in "$@"; do
              case "$arg" in
                /imsvc) args+=("-isystem") ;;
                *) args+=("$arg") ;;
              esac
            done
            exec ${pkgs.llvmPackages.clang-unwrapped}/bin/clang "''${args[@]}"
          '';

          # Linux native deps for webkit + GTK stack.
          # NOTE: cairo / pango / harfbuzz / atk / gdk-pixbuf are propagated by
          # gtk3, so nixpkgs' pkg-config setup hook picks them up automatically
          # under `pkgs.mkShell` and `stdenv.mkDerivation`. We still list them
          # here explicitly because `numtide/devshell` does not run that hook,
          # and the devshell's PKG_CONFIG_PATH is built from this list below.
          # Listing them in the package build too is harmless (they're already
          # propagated) and keeps one source of truth for Linux deps.
          linuxBuildInputs = lib.optionals pkgs.stdenv.isLinux [
            pkgs.webkitgtk_4_1
            pkgs.gtk3
            pkgs.cairo
            pkgs.pango
            pkgs.harfbuzz
            pkgs.atk
            pkgs.gdk-pixbuf
            pkgs.libsoup_3
            pkgs.glib
            pkgs.glib-networking
            pkgs.openssl
            pkgs.zlib
            pkgs.alsa-lib
            pkgs.libayatana-appindicator
            # webkit2gtk delegates <video>/<audio> rendering to GStreamer.
            # Without gst-plugins-base the dev log fills with
            # `GStreamer element appsink not found. Please install it.`
            # and any future media element fails silently.
            pkgs.gst_all_1.gstreamer
            pkgs.gst_all_1.gst-plugins-base
            # Desktop-wide GSettings schemas (org.gtk.Settings.FileChooser,
            # org.gnome.desktop.interface, etc.). Without this package GTK's
            # file chooser aborts the process on open with
            # `GLib-GIO-ERROR: No GSettings schemas are installed`.
            pkgs.gsettings-desktop-schemas
          ];

          commonCraneArgs = {
            inherit src;

            strictDeps = true;

            nativeBuildInputs = [
              pkgs.pkg-config
              pkgs.cmake
              pkgs.perl
            ]
            ++ lib.optionals pkgs.stdenv.isLinux [
              pkgs.wrapGAppsHook4
            ];

            buildInputs = darwinBuildInputs ++ linuxBuildInputs;

            # Sane deployment target — nixpkgs-unstable stdenv defaults to the
            # SDK version (26.x) which aws-lc-sys rejects.
            env = lib.optionalAttrs pkgs.stdenv.isDarwin {
              MACOSX_DEPLOYMENT_TARGET = "11.0";
            };
          };

          # Cargo deps — cached separately from source changes.
          # Uses cargoSrc (Cargo files + *.rs only) so UI/asset edits
          # don't invalidate the dependency cache.
          cargoArtifacts = craneLib.buildDepsOnly (
            commonCraneArgs
            // {
              src = cargoSrc;

              # Tauri build.rs needs a frontend dir to exist
              preBuild = ''
                mkdir -p src/ui/dist
                echo '<html></html>' > src/ui/dist/index.html
              '';
            }
          );

          # Tauri desktop app
          claudette = craneLib.buildPackage (
            commonCraneArgs
            // {
              inherit cargoArtifacts;
              cargoExtraArgs = "-p claudette-tauri";

              preBuild = ''
                mkdir -p src/ui/dist
                cp -r ${frontend}/* src/ui/dist/
              '';

              # claudette-tauri's pty/usage tests spawn real shells and hit
              # the network — neither works in the Nix sandbox. CI (GitHub
              # Actions) runs `cargo test -p claudette -p claudette-server`
              # against a regular Linux runner to cover the logic under
              # test; skip tests here to keep `nix build` reproducible.
              doCheck = false;

              meta = commonMeta // {
                description = "Cross-platform desktop orchestrator for parallel Claude Code agents";
                mainProgram = "claudette";
              };
            }
          );

          # Headless server binary — version from src-server/Cargo.toml
          serverInfo = craneLib.crateNameFromCargoToml { cargoToml = ./src-server/Cargo.toml; };

          claudette-server = craneLib.buildPackage (
            commonCraneArgs
            // {
              inherit cargoArtifacts;
              pname = serverInfo.pname;
              version = serverInfo.version;
              cargoExtraArgs = "-p claudette-server";

              meta = commonMeta // {
                description = "Headless Claudette backend for remote access";
                mainProgram = "claudette-server";
              };
            }
          );
        in
        {
          # -- Packages ----------------------------------------------------------
          packages = {
            default = claudette;
            inherit claudette claudette-server frontend;
          };

          # -- Checks ------------------------------------------------------------
          # `claudette` (the Tauri binary) is only included on Linux:
          # the macOS build requires Apple's Swift toolchain (`swiftc`)
          # for the Apple Speech FFI bridge in src-tauri/build.rs, which
          # is not available in the pure Nix sandbox. Use `cargo tauri
          # build` outside the sandbox to produce the macOS bundle.
          # `claudette-server` has no Swift dependency and builds clean
          # on all platforms.
          checks = {
            inherit claudette-server;
          }
          // lib.optionalAttrs pkgs.stdenv.isLinux {
            inherit claudette;
          }
          // {
            clippy = craneLib.cargoClippy (
              commonCraneArgs
              // {
                inherit cargoArtifacts;
                cargoClippyExtraArgs = "--workspace --all-targets -- -D warnings";

                preBuild = ''
                  mkdir -p src/ui/dist
                  echo '<html></html>' > src/ui/dist/index.html
                '';
              }
            );

            fmt = craneLib.cargoFmt { inherit src; };
          };

          # -- Dev shell ---------------------------------------------------------
          devshells.default = {
            name = "claudette";

            packages = [
              rustToolchain
              pkgs.bun
              pkgs.cargo-tauri
              pkgs.pkg-config
              pkgs.cmake
              pkgs.perl
              pkgs.cargo-llvm-cov
              # Windows cross-compile toolchain. cargo-xwin shells out to
              # clang-cl (the MSVC-compatible driver) and llvm-lib / llvm-ar
              # as the archiver; rust-lld is bundled with the fenix rustc
              # above, so no separate lld package is needed.
              #
              # clangXwinShim wraps plain `clang` (see its definition above)
              # to rewrite `/imsvc` → `-isystem`; `lib.hiPrio` lets it win the
              # buildEnv symlink conflict over clang-unwrapped's own
              # `bin/clang`, while clang-unwrapped's other binaries
              # (clang-cl, clang++, ...) pass through unchanged.
              #
              # We intentionally use clang-unwrapped rather than
              # llvmPackages.clang: the cc-wrapper variant only exposes the
              # `clang` / `clang++` entry points and hides the `clang-cl`
              # symlink that cargo-xwin looks up on PATH. llvmPackages.llvm
              # gives the raw LLVM binaries (llvm-lib, llvm-ar, llvm-rc);
              # we avoid llvmPackages.bintools because its wrapper symlinks
              # (`strip`, `ar`, ...) collide with same-named symlinks
              # elsewhere in the devshell's buildEnv.
              pkgs.cargo-xwin
              (lib.hiPrio clangXwinShim)
              pkgs.llvmPackages.clang-unwrapped
              pkgs.llvmPackages.llvm
              # aws-win-spinup / aws-win-destroy helpers shell out to these.
              # Pinning them here means teammates on plain Darwin don't need
              # a system awscli/openssl install for the devshell to work.
              # openssl is used by aws-win-spinup for random password
              # generation; awscli2 drives the EC2 API calls.
              pkgs.awscli2
              pkgs.openssl
              # Community registry signing — minisign is the canonical C
              # impl, rsign2 (binary name `rsign`) is the pure-Rust signer.
              # Either signs/verifies the same on-wire format. Used by
              # claudette-community CI to sign registry.json; mirrored
              # into the devshell so maintainers can re-sign locally
              # when bootstrapping a new key or auditing a published sig.
              pkgs.minisign
              pkgs.rsign2
            ]
            ++ darwinBuildInputs
            ++ linuxBuildInputs
            ++ lib.optionals pkgs.stdenv.isLinux [
              # Anchor cc / ld / binutils to THIS flake's nixpkgs revision.
              # Without this, the devshell picks up whatever system cc is on
              # the user's PATH — on NixOS that's often an older-channel
              # glibc, which then mismatches webkitgtk_4_1 (built against
              # unstable's newer glibc) and fails at dynlink time with
              # "version `GLIBC_2.XX' not found".
              pkgs.stdenv.cc
              pkgs.wrapGAppsHook4
            ];

            env = [
              {
                name = "RUST_SRC_PATH";
                value = "${fenixPkgs.latest.rust-src}/lib/rustlib/src/rust/library";
              }
              {
                # cargo-xwin downloads the Microsoft CRT + Windows SDK
                # headers on first Windows cross-build. Setting this to "1"
                # signals acceptance of the Microsoft Software License Terms
                # (https://go.microsoft.com/fwlink/?LinkID=2109288) so the
                # download is non-interactive. The cache lives under
                # ~/.cache/cargo-xwin/xwin and is reused across builds.
                name = "XWIN_ACCEPT_LICENSE";
                value = "1";
              }
            ]
            ++ lib.optionals pkgs.stdenv.isLinux [
              {
                # numtide/devshell doesn't run nixpkgs' pkg-config setup hook,
                # so propagated transitive deps (cairo/pango/atk/...) don't end
                # up on PKG_CONFIG_PATH automatically. Build it by hand from
                # linuxBuildInputs — see the note there about why the full
                # gtk3 closure is listed explicitly.
                name = "PKG_CONFIG_PATH";
                value = lib.makeSearchPath "lib/pkgconfig" (map lib.getDev linuxBuildInputs);
              }
              {
                # Runtime dynamic linker search path. webkit2gtk/gtk/
                # libayatana-appindicator are dlopen'd at `cargo tauri dev`
                # launch time — without this the window never opens.
                name = "LD_LIBRARY_PATH";
                value = lib.makeLibraryPath linuxBuildInputs;
              }
              {
                # Link-time search path replacement for NIX_LDFLAGS.
                # Under `pkgs.mkShell`, the cc-wrapper setup hook would add
                # every buildInput's lib dir to the linker search path.
                # devshell skips that hook, so libs referenced by naked -l
                # entries inside a .pc Libs: field (e.g. `-lz` inside
                # gdk-3.0.pc) are unreachable even though the package is
                # in buildInputs. We hand rustc the full list of -L paths
                # so rust-lld can resolve them during the final link step.
                name = "RUSTFLAGS";
                value = lib.concatStringsSep " " (map (p: "-L${lib.getLib p}/lib") linuxBuildInputs);
              }
              {
                # WebKitGTK's DMA-BUF renderer crashes the Wayland session on
                # current Mesa/compositors with `Gdk-Message: Error 71
                # (Protocol error) dispatching to Wayland display`. Disabling
                # DMA-BUF falls back to a GL-via-EGL path that's stable on
                # GNOME/KDE/Sway on NixOS while still keeping webkit's GL
                # compositor active — which is what drives HiDPI scaling, so
                # leaving compositing mode enabled keeps devicePixelRatio
                # honoring the GTK scale factor. Tauri upstream recommends
                # this workaround until webkit2gtk ships a fix.
                name = "WEBKIT_DISABLE_DMABUF_RENDERER";
                value = "1";
              }
              {
                # glib-networking ships the GIO TLS backend (libgiognutls.so)
                # that webkit uses for every HTTPS request. nixpkgs' setup
                # hook would normally prepend its gio/modules path to
                # GIO_EXTRA_MODULES; devshell doesn't run hooks, so webkit
                # loads with no TLS backend and every fetch to https://
                # errors with `TLS support is not available`. Prepend (don't
                # replace) so inherited gvfs/dconf modules from the host
                # session are still picked up.
                name = "GIO_EXTRA_MODULES";
                prefix = "${pkgs.glib-networking}/lib/gio/modules";
              }
              {
                # Force the app through XWayland. webkit2gtk's native-Wayland
                # path mis-handles fractional scaling on current NixOS
                # compositors: window.devicePixelRatio comes back as -1/96
                # and innerWidth/innerHeight as large negatives, collapsing
                # the entire layout into a negative viewport. XWayland
                # exposes only integer scale factors to the client, which
                # avoids the broken fractional-scale code path entirely.
                # Slight HiDPI fidelity loss vs. native Wayland is an
                # acceptable dev-loop tradeoff until upstream webkit2gtk
                # ships a fix.
                name = "GDK_BACKEND";
                value = "x11";
              }
              {
                # GSettings schema search path. nixpkgs installs compiled
                # schemas at $out/share/gsettings-schemas/$NAME/glib-2.0/
                # schemas/, and GIO walks XDG_DATA_DIRS appending
                # glib-2.0/schemas/ to each entry. Without this prefix, the
                # GTK file chooser aborts the process the first time it's
                # opened (`GLib-GIO-ERROR: No GSettings schemas are
                # installed`). Prepend both the desktop-wide schemas
                # (FileChooser, Interface, etc.) and gtk3's own schemas,
                # preserving any inherited host paths after.
                name = "XDG_DATA_DIRS";
                eval = ''"${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"'';
              }
            ]
            ++ lib.optionals pkgs.stdenv.isDarwin [
              {
                # Use Apple's native clang — Nix's CC wrapper has SDK version
                # mismatches (e.g. -mmacosx-version-min=26.4) that break aws-lc-sys
                name = "CC";
                value = "/usr/bin/cc";
              }
              {
                # Pin the C++ compiler to Apple's clang++ too. Without this
                # override, `cc-rs` (used by mlua-sys to build Luau and by
                # libsqlite3-sys/objc2 for their C++ shims) resolves `c++`
                # from PATH. On a nix-darwin system that's typically a
                # /run/current-system/sw/bin/c++ symlink into the GCC
                # wrapper, which compiles against libstdc++ (producing
                # `std::__cxx11::...` and `std::__glibcxx_assert_fail`
                # references). The final link uses Apple clang which pulls
                # in libc++ (`std::__1::...`), so the libstdc++ symbols go
                # undefined. Forcing CXX to Apple's clang++ keeps the
                # whole toolchain on libc++.
                name = "CXX";
                value = "/usr/bin/c++";
              }
              {
                # `cc-rs` reads the HOST_ variants for build-script-side
                # compilation. Set them too so build scripts (e.g. tauri
                # codegen, proc macros that shell out) don't fall back to
                # the nix-darwin GCC wrapper either.
                name = "HOST_CC";
                value = "/usr/bin/cc";
              }
              {
                name = "HOST_CXX";
                value = "/usr/bin/c++";
              }
              {
                name = "CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER";
                value = "/usr/bin/cc";
              }
              {
                # Clear system CFLAGS that leak through direnv from nix-darwin
                name = "CFLAGS";
                value = "";
              }
              {
                name = "CXXFLAGS";
                value = "";
              }
            ];

            commands = [
              {
                name = "dev";
                command = "exec ./scripts/dev.sh";
                help = "Start Tauri dev mode with hot-reload (auto-selects free Vite + debug ports)";
                category = "development";
              }
              {
                name = "docs-dev";
                command = ''
                  cd "$PRJ_ROOT/site"
                  [ -d node_modules ] || bun install --frozen-lockfile
                  exec bun run dev "$@"
                '';
                help = "Start the docs site (Astro/Starlight) in dev mode with hot-reload (default http://localhost:4321)";
                category = "documentation";
              }
              {
                name = "build-app";
                command = "cargo tauri icon assets/logo.png && cargo tauri build --features server";
                help = "Build release app bundle (.app / .deb) with embedded server";
                category = "development";
              }
              {
                name = "check";
                command = ''
                  mkdir -p src/ui/dist
                  [ -f src/ui/dist/index.html ] || echo '<html></html>' > src/ui/dist/index.html
                  cargo clippy --workspace --all-targets -- -D warnings && cd src/ui && bunx tsc --noEmit
                '';
                help = "Run clippy + TypeScript type checks";
                category = "quality";
              }
              {
                name = "fmt";
                command = "cargo fmt --all && cd src/ui && bunx eslint --fix .";
                help = "Format Rust and TypeScript code";
                category = "quality";
              }
              {
                name = "run-tests";
                command = "cargo test --workspace --all-features";
                help = "Run all Rust tests";
                category = "quality";
              }
              # Windows cross-build + deploy + AWS ephemeral-host helpers.
              # All bodies live in ./scripts/ — the devshell commands are
              # thin wrappers so flake.nix doesn't carry hundreds of lines
              # of bash-in-nix-strings. See scripts/*.sh for the logic and
              # scripts/_aws-common.sh for the shared helpers (profile/
              # region defaults, state dir under $PRJ_ROOT/.claudette/,
              # instance discovery).
              {
                name = "build-win-arm64";
                command = ''exec "$PRJ_ROOT/scripts/build-win.sh" arm64 "$@"'';
                help = "Cross-compile claudette.exe for aarch64-pc-windows-msvc (Windows on ARM)";
                category = "windows";
              }
              {
                name = "deploy-win-arm64";
                command = ''exec "$PRJ_ROOT/scripts/deploy-win.sh" arm64 "$@"'';
                help = "Build + deploy aarch64-pc-windows-msvc exe to the test VM (overridable via CLAUDETTE_WIN_HOST / CLAUDETTE_WIN_REMOTE_PATH)";
                category = "windows";
              }
              {
                name = "build-win-x64";
                command = ''exec "$PRJ_ROOT/scripts/build-win.sh" x64 "$@"'';
                help = "Cross-compile claudette.exe for x86_64-pc-windows-msvc";
                category = "windows";
              }
              {
                name = "deploy-win-x64";
                command = ''exec "$PRJ_ROOT/scripts/deploy-win.sh" x64 "$@"'';
                help = "Build + deploy x86_64-pc-windows-msvc exe (auto-discovers aws-win-spinup instance, or override via CLAUDETTE_WIN_HOST)";
                category = "windows";
              }
              {
                name = "aws-win-spinup";
                command = ''exec "$PRJ_ROOT/scripts/aws-win-spinup.sh" "$@"'';
                help = "Launch ephemeral Windows EC2 (us-west-2) with SSH+pubkey pre-configured and admin password baked in";
                category = "windows";
              }
              {
                name = "aws-win-rdp";
                command = ''exec "$PRJ_ROOT/scripts/aws-win-rdp.sh" "$@"'';
                help = "macOS: open the current aws-win-spinup instance in Windows App with admin password on clipboard";
                category = "windows";
              }
              {
                name = "aws-win-destroy";
                command = ''exec "$PRJ_ROOT/scripts/aws-win-destroy.sh" "$@"'';
                help = "Terminate all claudette-spinup tagged EC2 instances in AWS_REGION (default us-west-2) and scrub local state";
                category = "windows";
              }
              {
                name = "coverage";
                command = ''
                  mkdir -p src/ui/dist
                  [ -f src/ui/dist/index.html ] || echo '<html></html>' > src/ui/dist/index.html
                  cargo llvm-cov --workspace --all-features --lcov --output-path lcov.info
                  cargo llvm-cov report --html
                  cargo llvm-cov report
                  echo ""
                  echo "lcov:  lcov.info"
                  echo "html:  target/llvm-cov/html/index.html"
                '';
                help = "Run tests with coverage (terminal summary + lcov + HTML report)";
                category = "quality";
              }
            ];
          };

          # -- Formatting --------------------------------------------------------
          treefmt = {
            projectRootFile = "flake.nix";
            programs.nixfmt.enable = true;
            programs.rustfmt = {
              enable = true;
              package = rustToolchain;
            };
          };
        };
    };
}
