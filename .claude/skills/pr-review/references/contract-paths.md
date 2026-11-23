# Contract paths

Supporting material for the `## Contract paths` section of `SKILL.md`. Read it in full before
reviewing a PR that changes persisted data, an IPC/CLI/RPC surface, settings, plugin APIs, localized
strings, or terminal/session/worktree semantics. A diff-only pass on these surfaces is not a review.

## Why this exists

Users upgrade Claudette in place. Their SQLite database, `app_settings` rows, plugin directory,
saved workspaces and sessions, CLI scripts, paired mobile clients, and remote servers were all
written by an older release, and some of them (a paired server, a CLI on `PATH`, a user plugin) may
be running a different version from the app at the same moment. A contract change is correct only
if every one of those readers still works.

Contract defects rarely sit on a line that is wrong in isolation. They live in the interaction
between the changed producer and a consumer the diff did not touch: a different crate, the mobile
client, a plugin, or a row written last month.

## The trace

For every changed contract (a column, a serialized type in `src/model/`, a command's arguments or
return shape, an event payload, a CLI flag or output line, a settings key, a plugin manifest field or
`host.*` function, a translation key, a terminal or worktree behavior), walk it through each stage
and write down what each stage does. Open the code. Grep for the field name, the command name, the
event name, and the settings key string to find consumers the diff does not mention.

**Producers.** Every place that writes it: Tauri commands, the CLI IPC dispatch
(`src-tauri/src/ipc.rs`), the remote host (`src-tauri/src/remote_host.rs`) and the standalone server
(`src-server/`), migrations, background tasks, plugin seeding (`src/plugin_runtime/seed.rs`).

**Consumers.** Every place that reads it: the frontend (`src/ui/src/services/tauri/`, store
slices, components), the CLI's output formatting, the mobile client (`src-mobile/`), the WSS client
transport (`src/transport/`), Lua plugins in `plugins/*/` and user plugins you cannot see, docs under
`site/src/content/docs/`, and tests. A consumer the producer was not changed for is the most common
defect.

**Old data.** What happens when this release reads a value the previous release wrote? A renamed
serde field without `#[serde(alias)]`, a new non-`Option` field without `#[serde(default)]`, an enum
variant renamed, a settings value parsed more strictly, a `NOT NULL` column without a default. Load
an old row in your head and follow it through the new code.

**Mixed versions.** The CLI, a paired remote server, and the mobile app can each be a release behind
or ahead of the desktop app. Does an older client get a clear error or silently wrong data? Is a new
RPC method or field additive?

**Migrations.** New migration file named with a UTC timestamp, registered in `MIGRATIONS`, forward
only, `IF NOT EXISTS` on new tables and indexes, no edits to released files (`AGENTS.md` "Schema
migrations"; CI's `Migration guard` job enforces the last one). Does the migration handle existing
rows (backfill, default)? Two migrations in one batch: do the timestamps sort in the order they must
run?

**Removal.** Is anything removed or renamed (a command, a flag, a settings key, a translation key, a
UI control)? `AGENTS.md` "Regression discipline" says not without an explicit ask. Was it asked for,
and does the PR summary say so?

**Docs.** Does `site/src/content/docs/` describe the old behavior? A settings control belongs in
`features/settings.mdx`.

## Questions to answer

Answer each on a contract-path PR. One that does not apply gets a few words saying why in the
coverage line.

- If a user upgrades with yesterday's database and settings, does every screen, command, and CLI
  call still work, with the same meaning?
- Which consumers outside the diff read this, and was each updated or shown not to need it?
- Is the change additive? If not, where does the PR say it is intentional, and where is the test
  that pins the new contract?
- Does a paired client or CLI one version apart get a clear error or wrong data?
- Is every user-visible string localized, and are existing keys preserved in every locale under
  `src/ui/src/locales/`?
- For terminal, session, or worktree behavior: what does a user who relied on the old behavior see
  now, and is it in the UAT plan?

## Severity

A traced scenario (old state, each step's `file:line`, the broken result) earns P1 without a
reproduction. A regression that breaks existing users on upgrade, or loses data, is P0. A contract
defect in a feature behind an experimental flag is still P1: the flag is the only thing holding it
back, and the finding names the flag.
