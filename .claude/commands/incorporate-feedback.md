Review and incorporate valid feedback from the current pull request.

## Steps

1. **Identify the PR** — Determine which PR to review:
   - Run `gh pr view --json number,url,title` to get the current branch's PR
   - If no PR exists, inform the user and stop

2. **Fetch all review comments** — Gather feedback:
   - Run `gh pr view --json reviews,comments` to get top-level PR comments and reviews
   - Use `gh api repos/{owner}/{repo}/pulls/{number}/comments` to get inline review comments
   - Focus on unresolved comments and actionable feedback

3. **Categorize each comment** — Sort feedback into two buckets:
   - **Clear and actionable** — The feedback points to an obvious improvement (e.g., a typo, missing error handling, a correctness bug, a straightforward refactor). Plan to incorporate these without asking.
   - **Ambiguous or debatable** — The feedback involves a style preference, an architectural suggestion, an unclear request, or has multiple valid responses. These need user input.

4. **Ask the user about ambiguous feedback** — For each ambiguous comment (or batch of related comments), present the user with a question that includes:
   - A brief quote or summary of the reviewer's comment for context
   - Concrete suggested options for how to address it (e.g., "Refactor to use X as suggested", "Add a code comment explaining the current approach")
   - An **"Ignore this feedback"** option — always included so the user can decline any suggestion
   - The user will also have the option to type a free-form response if none of the suggested options fit
   - Batch related comments into a single question where possible to reduce back-and-forth

5. **Make changes** — For feedback you're incorporating:
   - Implement the requested changes
   - Run the project's format, lint, typecheck (if applicable), and test commands after changes
   - Fix any issues introduced by the changes

6. **Respond to comments** — For every comment:
   - **Incorporated**: Reply confirming the change was made (e.g., "Done — updated to use `X` instead")
   - **Ignored by user's choice**: Reply with a clear, respectful explanation based on the user's reasoning (e.g., "We discussed this and decided to keep the current approach because..." or "Intentional — [user's reason]")
   - **Incorporated with the user's custom approach**: Reply describing what was done and why that approach was chosen
   - Use `gh api` to post replies to review comments

7. **Commit and push** — If changes were made:
   - Stage and commit using conventional commit format: `fix(scope): incorporate PR feedback`
   - Include specifics in the commit body about what was addressed
   - Push to the branch: `git push`

8. **Summary** — Report back what was changed and what was declined, with reasoning.
