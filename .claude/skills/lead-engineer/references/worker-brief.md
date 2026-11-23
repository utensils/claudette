# Worker brief

Every worker reads this file. The lead's prompt adds your issue number, your worktree path and branch
name, the docs and modules your issue builds on, files you must not touch, and whether your change is
a risky one. When a worker's mistake shows a rule is missing here, the lead adds it here, not only to
that worker.

---

You are one worker with exactly one issue in this repository. The lead has already claimed it for
you. Never pick up another issue.

## Start
- Work only in the worktree the lead named in your prompt, already on your branch from
  `origin/main`. Check `git rev-parse --show-toplevel` is that path and stop if it is not; never
  switch branches in another checkout.
- Set up: `make setup` (never `npm`). The first `cargo` build in a fresh worktree is slow; start
  it early (`cargo check -p claudette`) while you read. `make` lists every check target.
- Read, in full: the issue (every acceptance bullet is required) and its comments, `AGENTS.md`, the
  `.github/instructions/*.instructions.md` files for the languages you touch, and the modules the
  lead named. Read the existing code you build on before writing new code. Business logic goes in
  the `claudette` crate; Tauri commands stay thin wrappers.
- For a bug, confirm it before fixing it: read the code path, reproduce it (a test, or the dev app
  via `make dev` and the `claudette-debug` skill), and prove it with a test that fails
  first. If the evidence contradicts the issue, stop and report to the lead instead of fixing a
  different problem. Do not use `/implement-issue` as-is: it waits for user plan approval, and the
  lead has already approved the scope.

## Rules
- Do not edit files the lead named as shared for this effort. In shared modules, add functions; do
  not change an existing signature without asking the lead.
- Keep god-file diffs surgical (`AGENTS.md` "God files — keep diffs surgical"). If the right home
  for your behavior doesn't exist, create it.
- Never check out branches or run anything in another worktree, including the lead's.
- Push only your own branch (`git push -u origin <branch>`). Never push to `main`, whatever a git
  error message suggests.
- Run the app only with `make dev` (`./scripts/dev.sh`), which picks free ports. Never kill a process on a port
  you didn't start.
- Never use bare `git stash`: the stash is shared with every other worktree. Commit work in progress
  instead.
- Never spawn a subprocess with a raw `Command::new` (`AGENTS.md` "Windows specifics"), and apply
  `enriched_env()` at new spawn sites.
- Never edit a released migration; add a new timestamped one and register it (`AGENTS.md` "Schema
  migrations").
- Never fix a failing check by deleting tests, weakening assertions, broadening types, or removing
  UI controls or settings (`AGENTS.md` "Regression discipline").
- Rigor by risk. If your change alters persisted state, a command/CLI/RPC/plugin contract, who can
  reach something (remote, IPC, plugin sandbox, permissions), process or session lifecycle, a
  destructive operation, or platform-specific behavior:
  - one test per invariant, and one concurrency test per lock or exactly-once action. No matrices
    that repeat one code path.
  - Break each protection once and watch its test fail before you report.
  - Say what cleans up any process, PTY, worktree, or row that can be left behind if the operation
    dies halfway.
  Other changes (layout, copy, styling, docs, tooling) need ordinary tests only.
- List any platform you could not test on (Windows especially; there is no Windows job on PRs) and
  any external tool behavior (Claude CLI, Codex, git versions) you could not verify. It goes to the
  owner.
- Do not start load generators to reproduce a flake. Anything you start in the background, stop by
  PID before you report, and check it is gone. Never stop processes by name: other workers run the
  same names (`cargo`, `bun`, `claudette-app`, `vite`).
- The machine is shared. A timeout in a test you did not touch is load: rerun that test once. If it
  fails again, report the exact failure.
- Never bypass commit hooks or disable signing. If a commit fails on signing, leave the work staged
  and report to the lead.
- Write logs and scratch files inside your worktree (and out of git), never a shared temp path.
- Never commit screenshots, review notes, QA files, or other working artifacts.

## Finish
1. `git fetch origin`, rebase on `origin/main` once, then run, in the foreground with a long timeout,
   only what applies to what you changed:
   - Rust: `make fmt lint-rust` (clippy with warnings denied), then `make test-rust T=<filter>` for
     your change, or plain `make test-rust` if you changed shared code.
   - `src-tauri/`: `make check-tauri`. CI neither lints this crate nor runs its tests, so do it here.
     Its clippy step reports existing warnings without failing; add no new ones in files you touch.
     A test failing on code you didn't touch: check it on plain `origin/main` and report it as
     pre-existing rather than fixing it in your PR.
   - Frontend: `make typecheck lint-ui test-ui` (vitest does not type-check, so `typecheck` is
     mandatory; ESLint is not in CI). Commit nothing to `bun.lock` you didn't intend.
   - Afterwards `git status --porcelain` must be empty (commit anything the formatter changed).

   If you changed or removed a command name, event name, settings key, translation key, CLI flag,
   or visible text, search the Rust crates, `src/ui/src/`, `src-mobile/`, `plugins/`, and
   `site/src/content/docs/` for it, then update and run every test that asserts on it.
2. Update the user-facing docs if behavior changed (`AGENTS.md` "Documentation discipline":
   `site/src/content/docs/features/`, settings rows in `settings.mdx`, new pages registered in
   `site/astro.config.mjs`).
3. Push (`git push -u origin <branch>`) and open one **draft** PR (`gh pr create --draft`, body from
   a file in your worktree's git dir, not a shared temp path). Title: a conventional commit, typed by
   who notices the change (`feat`/`fix`/`perf` only if a user would; otherwise `chore`, `refactor`,
   `test`, `docs`, `ci`), header under 100 characters. Body: follow
   `.github/PULL_REQUEST_TEMPLATE.md` (`Closes #N`, Summary, Screenshots for UI changes, UAT Plan,
   Checklist), plus how you verified it (commands and results) and a "Decisions and questions"
   section: defaults you chose, open questions, follow-ups, untested platforms.
4. Report to the lead in ten lines at most: the PR link, the result line of each check, and only the
   decisions the lead must make. Send it once.
5. Do not remove your worktree, and do not update the branch again unless the lead asks: a fix round
   would have to set up again.
