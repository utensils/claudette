Review all uncommitted changes and create a well-structured commit using conventional commit format.

## Steps

1. **Pre-flight checks** — Run what applies to what changed (see "Before you commit" in `AGENTS.md`):
   - Rust (`*.rs`, `Cargo.*`): `make fmt lint-rust`, then `make test-rust T=<filter>` for what you changed; add `make check-tauri` if `src-tauri/` changed
   - Frontend (`src/ui/**`): `make typecheck lint-ui test-ui` (`tsc -b` is mandatory; vitest does not type-check)
   - Unsure what applies: `make check` runs everything CI checks
   - If any check fails, fix the underlying issue before proceeding. Never delete tests or weaken assertions to get green.

2. **Review changes** — Understand what's being committed:
   - Run `git status` to see all modified/untracked files
   - Run `git diff` to review unstaged changes
   - Run `git diff --cached` to review already-staged changes
   - Run `git log --oneline -5` to see recent commit style for context

3. **Stage files** — Add relevant files to staging:
   - Stage files by name (avoid `git add -A` or `git add .`)
   - Do NOT stage files that contain secrets (`.env`, credentials, etc.) or working artifacts (screenshots, review notes, scratch files)
   - If there are unrelated changes, group them into separate logical commits

4. **Draft commit message** — Use conventional commit format (types in `.commitlintrc.yml`):
   - Format: `<type>(<scope>): <description>`, header at most 100 characters
   - Type by who notices the change: `feat` / `fix` / `perf` only for user-visible behavior (they reach the changelog via release-please); otherwise `refactor`, `chore`, `test`, `docs`, `ci`, `build`, `style`
   - Scope: the area affected (e.g., `chat`, `scm`, `env`, `db`, `models`, `remote`, `terminal`, `cli`, `plugins`, `ui`, `ci`)
   - Description: concise summary of the "why", not the "what"
   - Add a body only if the subject can't carry it: a few lines on motivation or trade-offs, never a file-by-file list
   - Reference GitHub issues when applicable (e.g., `Closes #123`); keep footer lines under 100 characters

5. **Create the commit** — Use a HEREDOC for the message to preserve formatting. Never bypass hooks (`--no-verify`) or signing; if a hook or signing fails, leave the work staged and report:
   ```
   git commit -m "$(cat <<'EOF'
   type(scope): description

   Optional body with more context.
   EOF
   )"
   ```

6. **Verify** — Run `git status` after committing to confirm success.

## Examples

```
feat(chat): add per-session model override

Closes #456
```

```
fix(terminal): stop leaking PTYs when a workspace is archived

The archive path dropped the workspace row before the PTY reaper ran,
so the reaper never found the terminals to close.
```

```
refactor(scm): extract PR status polling from scm.rs
```
