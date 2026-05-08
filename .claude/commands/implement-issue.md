Implement the changes described in one or more GitHub issues passed via $ARGUMENTS.

## Arguments

`$ARGUMENTS` accepts one or more GitHub issue numbers in any of these formats:

- `123` — single issue
- `#123 #456` — multiple with hash prefixes
- `123,456,789` — comma-separated
- `#123, #456` — comma-separated with hashes

**Parsing rule:** strip all `#` characters, then split on commas and/or whitespace to extract individual issue numbers.

## Steps

1. **Fetch the issues** — Get the full details for each issue:
   - Parse `$ARGUMENTS` using the rule above to extract all issue numbers
   - For each issue number, run `gh issue view <number> --json title,body,labels,comments`
   - Read all titles, descriptions, and comments carefully for every issue

2. **Understand the context** — Research the codebase before making changes:
   - Identify which domains, files, and systems are affected across all issues
   - Read the relevant source files to understand the current behavior
   - Check `docs/` for any existing documentation on the affected areas
   - Review related tests to understand expected behavior and edge cases
   - If any issue references other issues or PRs, fetch those for additional context
   - When working with multiple issues, identify shared concerns, overlapping files, and dependencies between the issues

3. **Ask clarifying questions** — Before implementing, check for ambiguity:
   - If any issue is underspecified, missing acceptance criteria, or has multiple valid interpretations, stop and ask the user for clarification
   - If the combined scope seems larger than expected, confirm the approach before proceeding
   - If there are architectural decisions to make, present the options with trade-offs
   - When working with multiple issues, flag any conflicts or contradictions between issue requirements

4. **Plan the implementation** — Outline the approach:
   - Enter plan mode and draft a step-by-step implementation plan
   - Plan a single unified implementation that addresses all issues cohesively
   - Identify all files that need to be created or modified
   - Note any migrations, new dependencies, or configuration changes required
   - Call out where issue requirements interact or depend on each other
   - Call out risks or areas that need extra care
   - Wait for the user to approve the plan before proceeding

5. **Implement the changes** — Execute the plan:
   - Follow the patterns and conventions documented in CLAUDE.md
   - Write tests alongside the implementation (not after)
   - Reference issue numbers in code comments only when the context isn't self-evident
   - Update documentation in `docs/` if the changes affect documented features
   - **Leverage agents and teams for parallel work** — when the implementation involves independent workstreams (e.g., DAL + API route + UI, or multiple unrelated files), use subagents to work on them concurrently. Examples:
     - Spawn agents to research different parts of the codebase in parallel during the planning phase
     - Use agents to implement independent modules simultaneously (e.g., one for the data layer, one for tests)
     - Delegate verification tasks (format, lint, typecheck, test) to a background agent while continuing work
   - Prefer agents over sequential execution whenever tasks don't depend on each other

6. **Verify** — Ensure everything works:
   - Detect the project's toolchain from config files (e.g., `package.json`, `Makefile`, `mix.exs`, `Cargo.toml`, `pyproject.toml`)
   - Run the project's **format** command (e.g., `prettier`, `mix format`, `cargo fmt`, `ruff format`)
   - Run the project's **lint** command (e.g., `eslint`, `mix credo`, `cargo clippy`, `ruff check`)
   - Run the project's **typecheck** command if applicable (e.g., `tsc --noEmit`, `mypy`, `mix dialyzer`)
   - Run the project's **test** command (e.g., `jest`, `mix test`, `cargo test`, `pytest`)
   - If any check fails, fix the issues before proceeding

7. **Report** — Summarize what was done:
   - List the files created or modified
   - Describe the approach taken and any trade-offs made
   - Note all issue numbers for commit messages (e.g., `Closes #123, Closes #456`)
   - Summarize which changes address which issues when working with multiple
   - Flag anything that needs manual testing or follow-up
