# Concurrency and lifecycle paths

Supporting material for the `## Concurrency and lifecycle paths` section of `SKILL.md`. Read it in
full before reviewing a PR that spawns, supervises, or kills processes, adds locks or background
tasks, or changes when worktrees, branches, sessions, or PTYs are created and destroyed.

## Why this exists

Claudette runs many agents at once, each with its own subprocess, PTYs, worktree, event stream, and
SQLite writes, while the user clicks, the CLI sends RPCs, and remote clients mirror events. Review
that follows whichever thread looks interesting samples the diff; the tables below replace sampling
with enumeration. Build each one from the code you opened, fill it in completely, and report it by
count in the coverage line (`reliability (lifecycle: 3 spawns, 2 have kill-on-drop, 1 filed;
invariants: 1 worktree path unique across 3 creators, 1 filed)`).

## Table 1: every resource, its owner, and what frees it

For each process, PTY, background task (`tokio::spawn`), file watcher, socket, or temp directory the
PR creates, write down: who owns the handle, what frees it on the happy path, and what frees it when
the owner errors, the workspace is archived, the window closes, the app quits, or the app crashes.

- **A spawned child needs a reaper.** `kill_on_drop`, an explicit kill in a `Drop`, or a supervisor
  that tracks it. On Windows, killing the parent does not kill its children; check process-tree
  handling where the child spawns its own children (shells, agent CLIs, MCP servers).
- **A `tokio::spawn` with no handle kept is fire-and-forget.** What stops it when its workspace goes
  away, and what does it do to a deleted directory if it keeps running?
- **Every spawn site goes through `claudette::process`** (`AGENTS.md` "Windows specifics") and
  applies `enriched_env()`.
- **"Nothing" is a finding** when the resource outlives its purpose: say which event leaks it and
  what the user sees (a zombie agent burning tokens, a PTY holding a file lock on Windows, a port
  still bound).

## Table 2: every invariant, every writer, what serializes them

For each thing the new code assumes stays true between a check and an action (a worktree path is
free, a branch name is unused, a session is idle, a PTY id is unique, a settings value hasn't
changed), list every code path that can break it: the GUI, the CLI, remote clients, background
tasks, the scheduler, other agents in other worktrees, and the user's own git commands in a
terminal.

Then, per writer, write down what stops it interleaving: a lock both take, a SQLite constraint, a
single-owner actor, or nothing.

- **A lock only orders the writers that take it.** A new `Mutex` serializes the new path against
  itself and nothing else.
- **Reads that feed the action happen under the lock.** A value read before locking and acted on
  after loses whatever landed in between.
- **No `std::sync::Mutex` guard held across `.await`**, and no blocking I/O (`std::fs`, `std::process`
  `.output()`, a SQLite query) on the async runtime without `spawn_blocking`.
- **`rusqlite::Connection` is not `Send`** (`AGENTS.md` "Architecture"). A fresh connection
  per command; two connections writing the same rows need a transaction or a constraint.
- **The losing side of a race needs its own outcome.** When the check fails because another writer
  won, what does the caller report?

## Table 3: every event, its emitter, and every listener

For each Tauri event, IPC response, or remote-mirrored event the PR emits or changes: list the
emitter, every listener (React hooks, the tray, notifications, the remote host's mirror, the CLI),
and what happens when the listener isn't there yet (the webview is reloading, macOS has suspended
JS while hidden, the remote client is disconnected).

- **Notification and sound work runs on the Rust side** (`src-tauri/AGENTS.md` "Notification architecture")
  because webview JS is suspended when the window is hidden. A new attention signal that only the
  webview handles never fires in the background.
- **Ordering.** Does the listener assume events arrive in an order the emitter does not guarantee
  (two streams, a retry, a reconnect replay)?
- **State derived from a stream** must be recoverable from a snapshot after a missed event, or the
  UI drifts until restart.

## Table 4: every destructive operation and its guard

For each operation that removes or rewrites user data (worktree remove, branch delete, reset, clean,
directory delete, session delete, transcript truncation, settings reset), write down the guard: what
proves the target is Claudette's own, what happens with uncommitted changes, whether the user
confirmed, and whether the operation is recoverable (a checkpoint, a snapshot, the reflog).

A destructive operation reachable from the CLI, a remote client, a schedule, or an agent tool, without
the confirmation the GUI path shows, is a P0 candidate.

## Breaking a protection

For a risky change, ask the author (or check yourself in your own worktree) whether each new guard's
test fails when the guard is removed. A test that still passes with the protection deleted protects
nothing.
