# Checking, handing over and merging

The rule: what lands on `main` passed every check that ran on it (`gh pr checks <n>`, not only the
required ones) against the `main` it lands on. CI runs the full suite; the lead keeps that verdict
current and catches combinations early.

## Contents
- The check worktree
- Checking a batch together
- Keeping CI current
- Hand-over and merge
- When CI fails
- Ordering and hot files
- Stacked PRs

## The check worktree

Keep one worktree that only the lead uses, on a scratch branch (for example `lead/verify`), set up
once with `cd src/ui && bun install`. Workers and reviewers never check out branches or run anything
there. Never push its branch.

## Checking a batch together

CI checks each PR against `main` alone. Two PRs can each be green and still break each other (both
add the same command to the handler list; one changes a model type the other's code constructs; both
add a migration; both touch the same god file). Before handing a batch of two to four reviewed PRs
over, check them together. Run these as separate steps that each stop on failure:

```bash
git fetch origin
git checkout -B lead/verify origin/main

# One branch at a time, so a conflict names its branch.
git merge --no-edit origin/<branch-a>
git merge --no-edit origin/<branch-b>

# Check only the tree you meant to build.
git merge-base --is-ancestor origin/<branch-a> HEAD   # every branch is in
git merge-base --is-ancestor origin/<branch-b> HEAD
git status --short                                     # nothing unmerged or left over
(cd src/ui && bun install --frozen-lockfile)           # if a lockfile changed
cargo fmt --all --check
cargo clippy -p claudette -p claudette-server -p claudette-cli --all-targets --all-features
cargo test -p <crate> <filters for the changed areas>
(cd src/ui && bunx tsc -b)
(cd src/ui && bun run lint:css)
(cd src/ui && bun run test)
```

Do not chain these with `;` or `&&` across the merges: a chained command once checked a tree with
conflict markers, and once checked plain `main` after a merge gave up. If the batch carries
migrations, also run the migration tests (`cargo test -p claudette migrations`) so duplicate ids or
ordering problems show up here, not on `main`.

Run the full Rust test command here only when the batch touched shared code and no workers are
building; otherwise CI's `Test` job is the full run.

## Keeping CI current

Required checks are not strict, so a PR's green run reflects `main` as it was when the run started.
Before handing a PR over for approval, compare its last run with what has landed since:

- Nothing landed on `main` that touches the same modules, shared types, store slices, test support,
  or migrations: the run is current enough.
- Something did: update the branch (`gh pr update-branch <n>`, or merge `origin/main` on the
  worker's branch) and wait for the new run. Do not rerun the old run; it would test the old merge
  ref.

Do this **before** asking for approval: the ruleset dismisses stale approvals on push, so an update
after approval sends the PR back to the approver.

## Hand-over and merge

When a batch is checked together and every PR has nothing failing or pending in `gh pr checks <n>`
and is current:

1. Mark each PR ready for review (`gh pr ready <n>`).
2. Check each PR's title (the squash commit and the changelog entry) and that it closes the right
   issue. Check that unresolved Copilot comments were triaged (fixed, or answered with a reason).
3. Post the batch on the tracking issue and in your reply: PR links in the order they should land,
   each with one line on what it does and how it was reviewed. An author cannot approve their own
   PR, and code-owner review is required, so when the PRs are under the owner's login the approval
   comes from another member of the code-owner team: ask the owner who, and request that reviewer
   (`gh pr edit <n> --add-reviewer <login>`) rather than leaving it as the owner's move.
4. After a person approves, merge in that order with `gh pr merge <n> --squash`, if the owner gave
   you that permission. Otherwise they merge. Never `--admin`, never push to `main`.
5. After each merge, apply "Keeping CI current" to the PRs still waiting. Any update or fix commit
   pushed after approval dismisses the approval; the PR goes back to the approver before merge.
6. After the batch: record decisions, stop leftover processes by PID, remove worktrees
   (`git worktree remove`), delete merged local branches, unblock dependents.

If a signing or hook problem stops a commit, leave the work staged. Never bypass the hook or turn
signing off.

## When CI fails

- Read the failure before doing anything else. Decide which of these it is: the change, an
  interaction with something newly on `main`, something already broken on `main`, a flake, or CI
  itself (cache, runner, a GitHub API error).
- A real failure: send it back to the worker as part of its fix round, or fix it yourself if it is
  small.
- A test that fails on every PR: run it alone locally on plain `main`. If it fails there, fix `main`
  first; rerunning PRs will not help.
- A test that fails and then passes on a rerun of the same commit is flaky. Record it on the tracking
  issue and move on. Rerun the failed jobs (`gh run rerun <id> --failed`), not the whole workflow.
- An infrastructure failure: rerun the failed job once. If it repeats, report it to the owner.

## Ordering and hot files

- A PR that touches CI workflows, test support, `clippy.toml`, `Cargo.toml` workspace config, or
  many test files lands first and alone, with other merges held until it is in.
- Workers update their branch once, when you call their PR for a batch, not after every merge.
- Files several PRs keep editing (the god files in `AGENTS.md`, `src/migrations/mod.rs`,
  `src/ui/src/services/tauri/`, the Tauri command registration in `src-tauri/src/main.rs`, locale JSON files,
  `site/astro.config.mjs`, `AGENTS.md`) go to one PR per batch, or the second is updated and re-run
  after the first merges.
- Two migrations in one batch: check their timestamps sort in the order they must run.
- Resolve conflicts on the PR branch (merge `origin/main` into it and push), not in the check
  worktree, so the PR shows what will merge.

## Stacked PRs

Prefer not stacking: branch every worker from `origin/main`. If you do stack:

- Retarget the child to `main` before merging the parent with branch deletion, or GitHub may close
  the child.
- After the parent is squash-merged, the child shows as conflicting because it still carries the
  parent's original commits. Rebase the child onto `origin/main` with
  `git rebase --onto origin/main <parent-branch-tip>`, push, and let CI run again.
