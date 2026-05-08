Review all uncommitted changes and create a well-structured commit using conventional commit format.

## Steps

1. **Pre-flight checks** — Ensure the code is ready to commit:
   - Detect the project's toolchain from config files (e.g., `package.json`, `Makefile`, `mix.exs`, `Cargo.toml`, `pyproject.toml`)
   - Run the project's **format** command (e.g., `prettier`, `mix format`, `cargo fmt`, `ruff format`)
   - Run the project's **lint** command (e.g., `eslint`, `mix credo`, `cargo clippy`, `ruff check`)
   - Run the project's **typecheck** command if applicable (e.g., `tsc --noEmit`, `mypy`, `mix dialyzer`)
   - Run the project's **test** command (e.g., `jest`, `mix test`, `cargo test`, `pytest`)
   - If any check fails, fix the issues before proceeding

2. **Review changes** — Understand what's being committed:
   - Run `git status` to see all modified/untracked files
   - Run `git diff` to review unstaged changes
   - Run `git diff --cached` to review already-staged changes
   - Run `git log --oneline -5` to see recent commit style for context

3. **Stage files** — Add relevant files to staging:
   - Stage files by name (avoid `git add -A` or `git add .`)
   - Do NOT stage files that contain secrets (`.env`, credentials, etc.)
   - If there are unrelated changes, group them into separate logical commits

4. **Draft commit message** — Use conventional commit format:
   - Format: `<type>(<scope>): <description>`
   - Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`, `ci`, `build`
   - Scope: the domain or area affected (e.g., `orders`, `shipments`, `auth`, `api`)
   - Description: concise summary of the "why", not the "what"
   - Add a body paragraph if the change is non-trivial, explaining motivation or trade-offs
   - Reference GitHub issues when applicable (e.g., `Closes #123`)

5. **Create the commit** — Use a HEREDOC for the message to preserve formatting:
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
feat(orders): add bulk status update endpoint

Closes #456
```

```
fix(shipments): prevent duplicate tracking webhooks

The webhook handler wasn't deduplicating by tracking number,
causing duplicate fulfillment updates in Shopify.
```

```
refactor(dal): migrate inventory to event buffer pattern
```
