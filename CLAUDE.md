# Claudette

Cross-platform desktop orchestrator for parallel Claude Code agents, built with Rust and Iced.

## Build & test commands

```bash
cargo run                    # Build and run (debug)
cargo build --release        # Optimized release binary
cargo test --all-features    # Run all tests
cargo clippy --all-targets --all-features  # Lint (must pass with zero warnings)
cargo fmt --all --check      # Check formatting
```

IMPORTANT: CI sets `RUSTFLAGS="-Dwarnings"` — all compiler warnings are errors. Fix warnings before committing.

## Code style

- Rust edition 2024 — use modern idioms (`let chains`, `gen blocks` if stabilized, etc.)
- Default `rustfmt` and `clippy` rules — no custom overrides
- Prefer `cargo fmt` before committing; CI enforces it

## Commit conventions

- **Conventional commits required** — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`, `chore:`, etc.
- Header max 100 characters
- PR titles must also follow conventional commit format (validated by CI)
- Release management is automated via release-please

## Architecture

- **GUI**: Iced 0.14 (Elm architecture — `Message` enum, `update()`, `view()`)
- **Async runtime**: Tokio (via Iced's `tokio` feature) for process management and git operations
- **Data persistence**: SQLite via rusqlite (bundled)
- **Git operations**: Shelling out to `git` via `tokio::process::Command` for worktree ops
- **Terminal emulation**: libghostty integration planned (blocked on library stabilization; requires Zig toolchain)

When adding new features, follow the Iced/Elm pattern: define messages in the `Message` enum, handle them in `update()`, render in `view()`.

## Project structure

```
src/
  main.rs          — entry point, application wiring only
  app.rs           — App struct, new(), update(), view(), subscription(), theme()
  message.rs       — Message enum (single source of truth for all messages)
  db.rs            — SQLite database: connection, migrations, CRUD operations
  git.rs           — async git worktree operations (shells out to `git`)
  model/           — data types (no UI or IO logic)
    mod.rs
    repository.rs
    workspace.rs
  ui/              — view functions, one file per major UI region
    mod.rs
    sidebar.rs
    main_content.rs
    modal.rs
    fuzzy_finder.rs
    style.rs       — shared color constants and styling helpers
```

### Guidelines for new code

- **Data types** go in `model/` — keep them free of UI and IO dependencies
- **Service/IO modules** (`db.rs`, `git.rs`) live at `src/` level — they handle persistence and external process interaction
- **UI views** go in `ui/` — each major panel or overlay gets its own file. View functions take data by reference and return `Element<Message>`
- **Message variants** all live in `message.rs` — never define messages elsewhere
- **Update logic** stays in `app.rs` — this is the only place that mutates `App` state
- **Colors and styling constants** go in `ui/style.rs` — don't scatter inline color literals
- Add a new module when a file would exceed ~300 lines, or when a feature is logically distinct (e.g., `ui/diff_viewer.rs`, `model/checkpoint.rs`)

### Database conventions

- `rusqlite::Connection` is not `Send` — do NOT store it on `App`. Instead, store `db_path: PathBuf` and open a fresh connection in each `Task::perform` closure
- Schema migrations use `PRAGMA user_version` — bump the version when adding new migrations
- UI-only state (e.g., collapsed sections, selection) is NOT persisted — keep it in `App` fields

## Project context

- See GitHub Issue #5 for the full MVP PRD
- See GitHub Issue #11 for the Workspace Management TDD
- P0 features: workspace management, agent chat, diff viewer, integrated terminal, checkpoints, git/GitHub integration, scripts, repo settings
- Target platforms: macOS (Apple Silicon + Intel) and Linux (x86_64, Wayland + X11)

## Dependencies

- Add dependencies conservatively — binary size target is < 30 MB
- Cold start target is < 2 seconds to interactive UI
- When choosing crates, prefer well-maintained options with minimal transitive dependencies
