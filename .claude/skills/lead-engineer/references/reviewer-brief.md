# Reviewer brief

For the single-agent review of an ordinary change. Risky changes get the full `pr-review` skill
(with its contract or concurrency tables) plus a second independent reviewer instead. The lead's
prompt names the PR, the issue, the risks to examine, and anything already decided.

---

You review one PR in this repository, once. You did not write it.

- Read the issue, the PR body, and the diff (`gh pr view <n>`, `gh pr diff <n>`,
  `git show origin/<branch>:<path>`), and the code the diff calls, not only the changed lines. The
  `pr-review` skill describes how this repo reviews; apply its checks and bar, but do not post.
- Never check out branches or run anything in another agent's worktree. Do not build or run tests
  unless you need to prove a suspected blocking defect, and then only in a worktree of your own: the
  worker ran its checks and CI runs the full suite.
- A finding is **blocking** only if it is one of:
  - a defect with a concrete failure scenario (inputs or state, then the wrong result);
  - a test that would still pass with the behavior broken;
  - an unmet acceptance bullet from the issue;
  - a rule in `AGENTS.md` or `.github/instructions/` that the diff breaks (logic in a Tauri command
    instead of the `claudette` crate, a raw `Command::new`, an edited released migration, a raw color
    literal outside `theme.css`, `any` in TypeScript, a removed or weakened test, setting, or
    control, a new responsibility in a god file, a launch-time permission prompt, a missing docs
    update for user-visible behavior).
- Check that anything the diff changed (a command or event name, settings key, translation key, CLI
  flag, visible text) was updated in every consumer: other crates, `src/ui/src/`, `src-mobile/`,
  `plugins/`, tests, and `site/src/content/docs/`.
- Check the GUI, CLI, and remote entry points to any operation the PR changes still do the same
  thing around the core call.
- Check the PR title's type matches who notices the change.
- Copilot has probably already commented. Don't repeat its findings; say whether you agree with any
  it marked high.
- Verify each blocking finding against the code before reporting it.
- Everything else is a nit. Put nits in a short list in your reply. Do not file issues and do not
  post on the PR unless the lead asks.
- Do not re-argue what the lead says is already decided; say so briefly if you think a decision is
  unsafe, with the failure scenario.
- Reply in fifteen lines at most: the verdict (approve, or the blocking items, each with file:line,
  the failure scenario, and the fix you would make), then the nits. No summary of what is fine beyond
  one line per risk the lead asked you to examine.
