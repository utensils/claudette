# Claudette developer tasks. Run `make` (or `make help`) to list them.
#
# The targets mirror what CI runs (.github/workflows/ci.yml), so `make check`
# locally is the same bar a PR has to clear.
#
# Toolchain: inside the Nix devshell, commands run as-is. Otherwise, if mise
# is installed, they run through `mise exec` so mise.toml's toolchain and
# macOS linker env apply. Override with `make RUN= <target>`.
#
# Pass extra arguments with T (a test filter) or ARGS (anything else):
#   make test-rust T=migrations
#   make dev ARGS=--new

ifneq ($(DEVSHELL_DIR)$(IN_NIX_SHELL),)
RUN ?=
else
RUN ?= $(shell command -v mise >/dev/null 2>&1 && echo mise exec --)
endif

CORE_CRATES := -p claudette -p claudette-server -p claudette-cli
UI := src/ui
T ?=
ARGS ?=

.DEFAULT_GOAL := help

.PHONY: help setup dev run build docs-dev sidecar \
	fmt fmt-check lint lint-rust lint-ui lint-tauri lint-mobile typecheck \
	test test-rust test-ui test-tauri test-mobile check check-tauri coverage

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# --- Setup and running -------------------------------------------------------

setup: ## Install toolchain (mise, if present) and fetch Rust + frontend deps
	@if command -v mise >/dev/null 2>&1 && [ -z "$(DEVSHELL_DIR)$(IN_NIX_SHELL)" ]; then mise trust && mise install; fi
	cd $(UI) && $(RUN) bun install
	$(RUN) cargo fetch

$(UI)/node_modules: $(UI)/package.json $(UI)/bun.lock
	cd $(UI) && $(RUN) bun install
	@touch $@

dev: ## Run the app in dev mode via scripts/dev.sh (ARGS=--new|--clone|--clean|--help)
	$(RUN) ./scripts/dev.sh $(ARGS)

run: dev ## Alias for `make dev`

build: ## Release build of the app bundle
	$(RUN) cargo tauri build $(ARGS)

docs-dev: ## Run the docs site (site/) with hot reload
	cd site && $(RUN) bun install --frozen-lockfile && $(RUN) bun run dev

sidecar: ## Stage the debug CLI sidecar claudette-tauri needs to build
	$(RUN) scripts/stage-cli-sidecar.sh --profile debug
	@# tauri.conf.json points frontendDist at src/ui/dist; stub it so the crate
	@# builds without a full frontend build.
	@[ -f $(UI)/dist/index.html ] || { mkdir -p $(UI)/dist && echo '<html></html>' > $(UI)/dist/index.html; }

# --- Formatting and lint -----------------------------------------------------

fmt: $(UI)/node_modules ## Format Rust and auto-fix ESLint issues
	$(RUN) cargo fmt --all
	cd $(UI) && $(RUN) bunx eslint --fix .

fmt-check: ## Check Rust formatting (CI: Format)
	$(RUN) cargo fmt --all --check

lint: lint-rust lint-ui ## Clippy on the core crates + frontend lints

lint-rust: ## Clippy on claudette, -server, -cli with warnings denied (CI: Lint)
	$(RUN) cargo clippy $(CORE_CRATES) --all-targets --all-features -- -D warnings

lint-ui: $(UI)/node_modules ## CSS token check (CI: Frontend) + ESLint (not in CI)
	cd $(UI) && $(RUN) bun run lint:css
	cd $(UI) && $(RUN) bun run lint

# Warnings are reported, not denied: CI has never linted this crate and it carries
# existing clippy findings. Add `-- -D warnings` once those are fixed.
lint-tauri: sidecar ## Clippy on claudette-tauri (not in CI; reports, does not fail on warnings)
	$(RUN) cargo clippy -p claudette-tauri --all-targets

lint-mobile: ## Clippy on claudette-mobile, macOS only (CI: Mobile)
	$(RUN) cargo clippy -p claudette-mobile --target aarch64-apple-darwin --all-targets --locked -- -D warnings

typecheck: $(UI)/node_modules ## TypeScript project build check; vitest does not type-check
	cd $(UI) && $(RUN) bunx tsc -b

# --- Tests ---------------------------------------------------------------------

test: test-rust test-ui ## Rust core tests + frontend tests

test-rust: ## Tests for claudette, -server, -cli (CI: Test; T=<filter>)
	$(RUN) cargo test $(CORE_CRATES) --all-features $(T)

test-ui: $(UI)/node_modules ## Frontend tests with vitest (CI: Frontend; T=<path or pattern>)
	cd $(UI) && $(RUN) bun run test $(T)

test-tauri: sidecar ## Tests for claudette-tauri (CI only compiles them; T=<filter>)
	$(RUN) cargo test -p claudette-tauri $(T)

test-mobile: ## Tests for claudette-mobile, macOS only (CI: Mobile)
	$(RUN) cargo test -p claudette-mobile --locked $(T)

coverage: ## Rust test coverage like CI: lcov.info + HTML report
	$(RUN) cargo llvm-cov $(CORE_CRATES) --all-features --lcov --output-path lcov.info
	$(RUN) cargo llvm-cov report --html
	$(RUN) cargo llvm-cov report
	@echo "lcov: lcov.info   html: target/llvm-cov/html/index.html"

# --- Aggregates ------------------------------------------------------------------

check: fmt-check lint typecheck test ## Everything CI checks on a PR, minus platform jobs

check-tauri: lint-tauri test-tauri ## The claudette-tauri checks CI skips
