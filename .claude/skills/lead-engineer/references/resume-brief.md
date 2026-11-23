# Resume brief: finishing another agent's unfinished branch

Read `worker-brief.md` first; every rule there applies. The differences:

- The issue already has an implementation in progress by an agent that stopped early. The lead
  saved any uncommitted work as one commit (`chore(wip): snapshot uncommitted work for #N`) on the
  issue's branch and pushed it. Work in the existing worktree named in your prompt; do not create a
  new branch or worktree.
- The previous agent's comments ("passed review", "all tests pass") are claims about a tree nobody
  else saw. Treat them as unverified. Nothing on this branch has been reviewed.
- Start: go to the worktree, `git fetch origin`, check `git status` is clean, bring the branch up to
  date with `origin/main`, and resolve conflicts keeping main's behavior plus this issue's change.
  If both sides added a migration, check their timestamps are distinct and sort in the order they
  must run (`src/migrations/AGENTS.md`). Then `cd src/ui && bun install`, since the update may
  have changed dependencies.
- Read the issue and its comments in full and audit the work against every acceptance bullet:
  finish what is missing; delete anything out of scope, debug-only, or speculative; check it against
  `AGENTS.md` "Regression discipline" and "Architecture", plus the nested `AGENTS.md` for each area it touches. For a risky change, break each
  new protection once and watch its test fail.
- Replace the snapshot commit with clean commits before opening the PR. The PR title must not be the
  snapshot's.
- Report the final state honestly: what was already there, what you changed, what is still
  unverified.
