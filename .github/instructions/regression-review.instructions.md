---
applyTo: "**"
---

When reviewing or generating a PR, explicitly look for regressions before style issues. Ask: what existing user workflow, persisted value, IPC contract, CLI command, plugin API, terminal behavior, worktree operation, or localization path could this change break?

Flag any intended behavior change clearly. A PR that changes semantics should say so in the summary or UAT plan and should include tests for the new contract. Silent behavior changes are defects, even when the new behavior looks reasonable.

Check for accidental clobbering from agent work: unrelated file rewrites, deleted tests, loosened assertions, dropped translation keys, removed settings, renamed command fields, changed sort order, changed default values, and UI controls that vanish while nearby code is being refactored.

Prefer additive compatibility for persisted data and public-ish contracts. Existing databases, settings rows, plugin manifests, CLI output, Tauri command parameters, and saved workspace/session state should keep working across upgrades.

Every non-trivial fix should include the narrowest test that would have failed before the fix. If tests are impractical, the PR should include a concrete manual UAT checklist with the exact workflow and expected result.

For large-file edits, verify the change is local to the requested feature. If a god file grew because new behavior was added, consider whether a helper module, child component, store slice, or service function would better preserve ownership and reduce future regression risk.
