# Schema migrations

Migrations are `.sql` files in this directory, each registered as a `Migration` entry in the `MIGRATIONS` slice in `mod.rs`.

## Adding a migration

1. Create `YYYYMMDDHHMMSS_snake_case_description.sql`, named with the current UTC time (`date -u +%Y%m%d%H%M%S`).
2. Append `Migration { id, sql: include_str!(...), legacy_version: None }` to `MIGRATIONS`.
3. Keep it forward-only and additive. Use `IF NOT EXISTS` on new `CREATE TABLE` / `CREATE INDEX`. Give new columns a default, or backfill them, so existing rows still load.
4. Run `make test-rust T=migrations`. The tests check that ids are unique, the timestamp prefix format, and a fresh-DB apply.

On a branch that adds a migration, run the dev app with `make dev ARGS=--new` or `ARGS=--clone`. A plain run migrates your real `claudette.db`.

## Rules

- **Never edit, rename, or delete a released migration.** Its `id` is its tracked identity, so rewriting an applied one desyncs every database in the field. Fix forward with a new migration. CI's `Migration guard` job rejects these changes on PRs.
- **Same-second timestamp clash** (it shows up as a merge conflict in `mod.rs`): bump one migration's timestamp by a second and rename its file.
- **`PRAGMA user_version`** exists only to seed `schema_migrations` once on pre-redesign databases. Never read or write it in new code.
- **"Already exists" leniency:** the runner treats `SQLITE_ERROR` messages containing `"already exists"` or `"duplicate column name"` as benign. It logs `[migrations] <id> skipped: ...`, marks the migration applied, and continues. That keeps hand-applied dev DBs working. Never write a migration that relies on it.
