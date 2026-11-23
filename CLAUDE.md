@AGENTS.md

## Claude Code

Project instructions live in `AGENTS.md` (imported above) and the nested `AGENTS.md` files it lists. Edit those, not this file, unless the instruction applies only to Claude Code.

- Skills in `.claude/skills/`:
  - `claudette` — drive the running app through the CLI.
  - `claudette-debug` — inspect and drive a dev build's webview: store state, screenshots, monitoring, UAT. Use it for any UI debugging or post-change verification.
  - `pr-review` — review a PR.
  - `lead-engineer` — lead a multi-issue effort with parallel worker agents.
- Commands in `.claude/commands/`: `/implement-issue`, `/commit-changes`, `/pull-request`, `/incorporate-feedback`, `/rebase-on-main`.
- Personal, uncommitted instructions go in `CLAUDE.local.md` (gitignored).
