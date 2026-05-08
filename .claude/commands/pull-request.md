Open a pull request for the current branch against `main`.

## Arguments

- `$ARGUMENTS` — Pass `draft` to create a draft PR (e.g., `/pull-request draft`). If omitted, creates a regular PR.

## Steps

1. **Pre-flight checks** — Before opening the PR, ensure the code is ready:
   - Detect the project's toolchain from config files (e.g., `package.json`, `Makefile`, `mix.exs`, `Cargo.toml`, `pyproject.toml`)
   - Run the project's **format** command (e.g., `prettier`, `mix format`, `cargo fmt`, `ruff format`)
   - Run the project's **lint** command (e.g., `eslint`, `mix credo`, `cargo clippy`, `ruff check`)
   - Run the project's **typecheck** command if applicable (e.g., `tsc --noEmit`, `mypy`, `mix dialyzer`)
   - Run the project's **test** command (e.g., `jest`, `mix test`, `cargo test`, `pytest`)
   - If any check fails, fix the issues before proceeding

2. **Rebase on origin/main** — Ensure the branch is up to date:
   - Run `git fetch origin main`
   - Run `git rebase origin/main`
   - If there are conflicts, resolve them one file at a time:
     - Read the conflicting file to understand both sides
     - Apply the correct resolution preserving intent from both branches
     - Run `git add <file>` and `git rebase --continue`
   - After rebase, re-run pre-flight checks to ensure nothing broke

3. **Analyze changes** — Review all commits on this branch vs `origin/main`:
   - Run `git log origin/main..HEAD --oneline` to see all commits
   - Run `git diff origin/main...HEAD` to see the full diff

4. **Draft the PR** — Prepare the PR title and body:
   - **Title**: Use a concise, descriptive title (under 70 characters)
   - **Body** should include these sections:

     ### Summary
     A succinct description of what changed and why. Include a mermaid diagram if the changes involve schema changes, new flows, or architectural changes.

     ### Complexity Notes
     Flag any areas of complexity, risk, or non-obvious behavior that reviewers should pay close attention to. If there are none, omit this section.

     ### Test Steps
     Provide concrete, numbered steps a reviewer can follow to verify the changes work correctly. Be specific — include URLs, commands, or UI flows to check.

     ### Checklist
     - [ ] Tests added/updated
     - [ ] Documentation updated (if applicable)

5. **Push and create** — Push the branch and create the PR:
   - `git push -u origin HEAD`
   - If `$ARGUMENTS` is `draft`, run `gh pr create --draft` with the drafted title and body
   - Otherwise, run `gh pr create` with the drafted title and body

6. **Return the PR URL** to the user when done.
