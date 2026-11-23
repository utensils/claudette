# Lessons: what went wrong, and the rule it produced

These come from earlier multi-agent efforts, most of them on other codebases; the rules carry over
even where the details do not. Read them once when you take the role; they explain the rules in the
skill and the briefs, and they are the first things to suspect when a day goes badly. Add this
repo's own lessons to the end, dated.

## Checking the combination
- **A check ran on the wrong tree, twice** (a half-merged conflict; plain main after a merge gave
  up) because the steps were chained. Merge one branch at a time and check ancestry and a clean tree
  before checking anything else.
- **Two PRs passed alone and broke together** (the same item added twice; conflicting entries in a
  shared config). Check the combined tree, and update the second PR when two touch the same files.
- **A PR that changed test support landed last and was rebased six times.** Land wide PRs first,
  alone.
- **Every worker ran the full suite**, sometimes three times per PR. Load made correct timing tests
  fail, and the full runs found nothing the shared check did not. Full suite in one place; here,
  that is CI.

## Workers
- **A changed id, name, or visible text broke someone else's test** several times in a day. Workers
  search the whole tree for what they change.
- **CPU-burner loops left by a worker ran for hours** and caused slow checks and timeouts. No load
  generators; stop what you start, by PID.
- **A worker killed processes by name** and took down other workers' servers. PID only.
- **Parallel workers wrote PR bodies to one shared temp file** and opened PRs with each other's
  text. Scratch files live in the worker's own worktree.
- **A fix report described tests that were never committed.** Check the fix commits.
- **A stopped agent left uncommitted work and optimistic comments.** Snapshot it, treat the claims
  as unverified, and hand it over with the resume brief.

## Reviews
- **Thoroughness was over-corrected**: fix rounds for non-blocking notes, strong-model reviews on
  every labelled PR. The owner called it the slowest run they had seen. Only blocking findings cost
  a round; review depth follows the diff's risk, not its label.
- **Follow-up issues bred follow-up issues.** Nits go in the reply. An audit with dozens of findings
  is split by impact: what loses data or breaks users now, the rest in one issue.
- **A speculative fix to a shared hook, approved on the lead's own read, broke a passing test every
  run.** Shared infrastructure gets a full independent review, and no fix without a reproduction.
- **Tests passed with the protection removed.** For risky changes the worker breaks it once.
- **Things passed tests but failed under concurrency** (throttles, claims, exactly-once actions).
  Ask for a concurrency test.
- **Personal data turned up in the wrong place**: error bodies, job error text, logs with tokens in
  paths. Say it in the brief: nothing personal or secret in logs, errors, URLs, or debug output.

## The lead
- **Leading from the most expensive model cost far more than expected**, mostly from reading large
  outputs and repeated review round-trips. Keep the lead's context small and follow the owner's
  preference for which model leads.
- **A closing note overstated what was done.** Correct it where it was said, promptly.
- **The lead's own assumptions about a library were wrong** and a worker corrected them. Treat a
  worker's evidence as evidence; check documentation for anything recent.
- **Signing went down mid-session.** Work stayed staged; nothing was bypassed, and everything was
  committed once the owner fixed it.

## Hand-testing with the owner
- **A visual bug was a shared component's fault** (a default class beating the caller's), and showed
  on one page only by luck of stylesheet order. Find the cause; verify in the running app before and
  after; check the component's other callers.
- **Switching the running worktree to a new fix branch silently dropped earlier fixes** from what
  the owner saw. Keep one running branch that every fix is merged into.

## This repository
<Dated entries from efforts here.>
