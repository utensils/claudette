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
            fenixPkgs.latest.rust-src
            fenixPkgs.latest.rustc
            fenixPkgs.latest.rustfmt
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

            nativeBuildInputs = [ pkgs.bun ];

            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-B5jdCpB8PCOmBvptaigcRZRZSBBfQ4Tm6CaN+VMNvCI=";

            buildPhase = ''
              export HOME=$TMPDIR
              bun install --frozen-lockfile
              bun run build
            '';

            installPhase = ''
              cp -r dist $out
            '';
          };

          # Cargo-only source: Cargo.toml, Cargo.lock, and *.rs files.
          # Used by buildDepsOnly so UI/asset changes don't rebuild deps.
          cargoSrc = craneLib.cleanCargoSource ./.;

          # Full source: Cargo files + src-tauri config + assets (logo for tauri-codegen).
          src = lib.cleanSourceWith {
            src = ./.;
            filter =
              path: type:
              (craneLib.filterCargoSources path type)
              || (builtins.match ".*src-tauri/.*" path != null)
              || (builtins.match ".*assets/.*" path != null);
          };

          # Platform-specific build dependencies
          darwinBuildInputs = lib.optionals pkgs.stdenv.isDarwin [
            pkgs.apple-sdk_15
            pkgs.libiconv
          ];

          linuxBuildInputs = lib.optionals pkgs.stdenv.isLinux [
            pkgs.webkitgtk_4_1
            pkgs.gtk3
            pkgs.libsoup_3
            pkgs.glib
            pkgs.openssl
            pkgs.glib-networking
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

              meta = commonMeta // {
                description = "Cross-platform desktop orchestrator for parallel Claude Code agents";
                mainProgram = "claudette-tauri";
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
          checks = {
            inherit claudette claudette-server;

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
            ]
            ++ darwinBuildInputs
            ++ linuxBuildInputs
            ++ lib.optionals pkgs.stdenv.isLinux [
              pkgs.wrapGAppsHook4
            ];

            env = [
              {
                name = "RUST_SRC_PATH";
                value = "${fenixPkgs.latest.rust-src}/lib/rustlib/src/rust/library";
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
                command = "cd src/ui && bun install && cd ../.. && cargo tauri dev --features devtools";
                help = "Start Tauri dev mode with hot-reload";
                category = "development";
              }
              {
                name = "build-app";
                command = "cargo tauri icon assets/logo.png && cargo tauri build";
                help = "Build release app bundle (.app / .deb)";
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
                name = "test";
                command = "cargo test --workspace --all-features";
                help = "Run all Rust tests";
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
