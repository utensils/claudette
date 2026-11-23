# Challenging the approach

Supporting material for the `## Challenging the approach` section of `SKILL.md`. Read it when a diff
looks like one of the shapes below, or when you are about to file a challenge and need to know which
tier your evidence earns.

## Shapes this repository's rules exist to prevent

Each row maps to a rule in `AGENTS.md`. Cite the section; don't restate it.

| Shape | Tell in a diff | Ask | `AGENTS.md` section |
| --- | --- | --- | --- |
| Business logic in a Tauri command | a `#[tauri::command]` body that does more than parse, call into `claudette`, and map the result | "Can the CLI and remote host reach this without going through the webview?" | "Architecture" |
| A god file gaining a responsibility | a new concern added to a file on the god-file list | "Is there a focused module, hook, slice, or child component this belongs in?" | "God files — keep diffs surgical" |
| Launch-time work | new work in app setup or boot: enumeration, network, permission-gated APIs, heavy parsing | "What does this add to cold start, and does it trigger a macOS prompt the user didn't ask for?" | "macOS privacy-prompt contract", "Dependencies" |
| A dependency for a small job | a new crate or npm package, especially one with a large transitive tree | "What does this add to binary size, and is there a std or existing-dep way?" | "Dependencies" |
| UI state persisted, or session state in React | a DB column for a collapsed section or panel width; agent session data kept only in a component | "Who reads this after restart, and is that the right owner?" | "Architecture" |
| A platform branch with a silent fallback | `#[cfg(not(...))]` returning `Ok(())` or an empty value | "What does a user on that OS see, and does the UI say the feature is unavailable?" | "Windows specifics" |
| A symptom patched instead of its cause | a retry, a sleep, a `.ok()`, a `?? []`, or a reconcile pass added beside the code that produces the bad state | "What produces the bad state, and why isn't fixing that the change?" | "Regression discipline" |
| A fix by weakening | a deleted test, a loosened assertion, a broadened type, a removed control | "What was the test protecting, and what is the real mismatch?" | "Regression discipline" |
| A second copy of a shared operation | the CLI or remote host reimplementing what a Tauri command does | "Can both call one function in the `claudette` crate?" | "Architecture" |
| A hand-maintained derived value | a cached or denormalized value updated beside the write that changes it | "How many places write this, and what reconciles it when one is missed?" | |
| Blocking the async runtime | `std::fs`, `std::process` `.output()`, or SQLite on a Tokio worker; a sync mutex across `.await` | "What else stalls while this runs?" | "Architecture" |

When this degrades, the question is less "is it fast enough" than "what does the user see when it
goes wrong?" A spinner that never ends, an empty list that looks like no data, or an agent that
silently stopped streaming is the expensive case.

## Consistency or correction

The test is one question: **if this new instance is wrong, how does anyone find out?**

- A panic, a compile error, a failing test, a red CI job: the wrong instance reports itself.
  **Consistency wins**; match the surrounding code.
- A value quietly wrong, a list quietly empty, a Windows-only flash or a Linux-only packaging
  failure that nobody on the author's OS sees: **correction wins**, even if this file becomes the
  odd one out.

Two corollaries:

- **The Nth instance is not 1/N of the cost.** A pattern copied often is copy-attractive, which
  argues for stopping rather than continuing.
- **Only correct when the corrected form is importable.** `claudette::process`, `enriched_env()`, a
  theme token, an existing store slice are each one import. When correcting would mean inventing a
  local abstraction nobody else uses, you produce one more unique shape and a worse codebase.

## Where a challenge would be wrong

Read for the reason before objecting to something that looks like an oversight:

- **No launch-time voice or audio prewarm** is deliberate (macOS privacy-prompt contract), even
  though it makes every mic click cold.
- **mDNS discovery starting at launch** is a known, documented exception; changing it needs a
  replacement UX, not a drive-by fix.
- **A fresh SQLite connection per command** is the convention because `Connection` is not `Send`,
  not an inefficiency to pool away in passing.
- **Shelling out to `git`** rather than a git library is the architecture choice for worktree ops.
- **`rgba(var(--*-rgb), <alpha>)`** and the documented exceptions in
  `src/ui/AGENTS.md` are allowed color forms, not lint escapes.

## Earning a tier

- **Reproduction.** The exact command and its output, on which OS. For UI behavior, the
  `claudette-debug` skill can drive a dev build and read store state.
- **Measurement.** Cold start, binary size (`cargo tauri build` artifact size before and after),
  memory, or event volume, with the method and the machine. A number with no method doesn't count.
- **History.** A linked issue or PR in this repository where the same failure happened.

What does not count: a blog post asserting a preference, "best practice" with no mechanism, a
benchmark from a different workload, a citation you did not open, or your own confidence.

## How this lands in a review

- **The question form is the default, but it always names a consequence.** "Is it intentional that
  archived workspaces keep their PTY alive?" works. "Have you considered..." gets a one-line answer.
- **Offer alternatives as a menu with prices.** "Two options: move the side effect into the core
  function so the CLI gets it, or emit the event from both wrappers and add a parity test."
- **"Not blocking" is a contract.** It means merge this and file it. Don't re-raise it next round.
- **Say what convinced you when you withdraw.** An unfalsifiable block teaches everyone to route
  around the reviewer.
