Rebase the current branch on `origin/main` and resolve any conflicts.

## Steps

1. **Check for uncommitted changes** — Ensure the working tree is clean:
   - Run `git status` to check for uncommitted changes
   - If there are uncommitted changes, warn the user and stop — do not stash or discard work

2. **Fetch and rebase** — Update the branch:
   - Run `git fetch origin main`
   - Run `git rebase origin/main`
   - If the rebase completes cleanly, skip to step 4

3. **Resolve conflicts** — For each conflicting file:
   - Run `git diff` to see the conflict markers
   - Read the conflicting file to understand both sides of the conflict
   - Resolve the conflict by preserving the intent from both branches
   - Run `git add <file>` to mark as resolved
   - Run `git rebase --continue` to proceed
   - Repeat until all conflicts are resolved
   - If a conflict is ambiguous or risky, stop and ask the user for guidance

4. **Verify** — Ensure the rebase didn't break anything:
   - Detect the project's toolchain from config files (e.g., `package.json`, `Makefile`, `mix.exs`, `Cargo.toml`, `pyproject.toml`)
   - Run the project's **format** command (e.g., `prettier`, `mix format`, `cargo fmt`, `ruff format`)
   - Run the project's **lint** command (e.g., `eslint`, `mix credo`, `cargo clippy`, `ruff check`)
   - Run the project's **typecheck** command if applicable (e.g., `tsc --noEmit`, `mypy`, `mix dialyzer`)
   - Run the project's **test** command (e.g., `jest`, `mix test`, `cargo test`, `pytest`)
   - If any check fails, investigate and fix the issue

5. **Report** — Summarize what happened:
   - How many commits were rebased
   - Whether any conflicts were resolved (and what they were)
   - Whether all checks pass
