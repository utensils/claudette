# Effort runbook (tracking-issue body)

Use this as the body of the effort's tracking issue. Keep it short and current: it is what the next
lead, or you after a context reset, reads first. Status updates, decisions (`D1`, `D2`, ...) and
lessons go in comments; edit the body when a standing fact changes.

---

## Goal
<The outcome, and the exit list: the issues that must be merged for this to be done.>

## Where things stand
<Two or three lines: what is merged, what is in review or waiting for approval, what is blocked on
the owner. Update at the end of each session.>

## Standing permissions
<What the owner has said may be done without asking (push branches, open draft PRs, mark ready,
merge after approval) and what always needs asking (approvals, releases, paid services, credentials
and signing, anything outward-facing).>

## Commands
| What | Command | Notes |
| --- | --- | --- |
| New worktree | `git worktree add --no-track <path> -b <branch> origin/main` | or a Claudette workspace / the owner's worktree manager |
| Set up a worktree | `make setup` | first `cargo` build is slow; start it early |
| List targets | `make` | the Makefile mirrors CI |
| Run the app | `make dev` | wraps `./scripts/dev.sh`; `ARGS=--new` for a throwaway user |
| Everything CI checks | `make check` | fmt-check, lint, typecheck, test |
| Rust | `make fmt lint-rust` · `make test-rust T=<filter>` | clippy with warnings denied |
| Frontend | `make typecheck lint-ui test-ui` | `tsc -b` is mandatory; vitest doesn't type-check |
| `src-tauri/` | `make check-tauri` | CI never lints or runs these tests |
| Inspect the running app | `claudette-debug` skill | dev builds only |
| Review (risky) | `pr-review` skill + one independent reviewer | prints; posts only when told |
| Full CI | `CI` workflow on the PR | required: `Format`, `Test` only; not strict |
| Remove a worktree | stop its processes by PID, then `git worktree remove <path>` | |

## The lead's check worktree
<Path and branch (for example `lead/verify`). Only the lead uses it.>

## Limits
- At most <N> workers at once (measured: <what happened with more — Cargo builds, memory, disk for
  per-worktree `target/`>).

## Files workers must not edit in this effort
<Shared files several branches would fight over: god files from `AGENTS.md`, `src/migrations/mod.rs`
if one PR owns the migration, `AGENTS.md`, `.github/copilot-instructions.md`, `site/astro.config.mjs`,
locale files under `src/ui/src/locales/`, `src/ui/src/services/tauri/`.>

## Models
<Which model leads, which reviews which kind of change, which does UI and docs work.>

## Owner actions
<Things only the owner can do: a code owner to approve each ready PR (PR links), releases, manual
UAT on platforms the agents could not test (Windows, Linux Wayland/X11), signing or credential
fixes. Restated at each milestone.>
