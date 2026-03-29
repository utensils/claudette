# Permission Handling Design

**Status**: Research complete, ready for implementation
**Date**: 2026-03-29

## Problem

Claude Code CLI tools (Bash, Edit, etc.) can require user approval before executing. In `--print` mode, tools that need approval are auto-denied — the agent notes that permission was required and gives up. We need to support the approve/deny flow like the interactive CLI.

## Research Findings

### What does NOT work

We investigated several approaches that turned out to be non-viable:

1. **Removing `--print` and using interactive mode**: The CLI enters a TUI/terminal mode that doesn't work with piped stdin/stdout. The process hangs.

2. **`--input-format stream-json` with `control_request`/`control_response`**: The `control_request` protocol is an internal SDK mechanism, not exposed to CLI users. While `--input-format stream-json` exists, it's for sending user messages — the CLI does NOT emit `control_request` events on stdout for permission prompts. Tools are silently auto-denied in `--print` mode regardless of stdin format.

3. **`--permission-prompt-tool`**: This flag does not exist in CLI version 2.1.87. It may be a planned feature or exists only in the Agent SDK.

4. **Writing `y`/`n` to stdin**: `--print` mode does not read from stdin for approval decisions.

### What DOES work

Two viable approaches exist for CLI 2.1.87:

#### Option A: `--allowedTools` (Pre-approval via CLI flag)

```bash
claude -p --allowedTools "Bash,Read,Edit,Write,Glob,Grep" "your prompt"
```

- Tools listed execute without prompting
- Supports pattern matching: `Bash(git:*)`, `Bash(npm run *)`
- Static — must be decided before the turn starts
- Cannot approve/deny individual tool calls in real-time

#### Option B: Claude Agent SDK (Programmatic control)

The Python/TypeScript Agent SDK provides a `canUseTool` callback for real-time approval:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const msg of query({
  prompt: "...",
  options: {
    canUseTool: async (toolName, input) => {
      // Show UI, wait for user decision
      return { behavior: "allow" };
    }
  }
})) { ... }
```

This is the only way to get real-time approve/deny per tool call.

## Recommended Approach

### Phase 1: `--allowedTools` (Implement now)

Use `--allowedTools` to pre-approve common tools. Make the allowed tools list configurable per workspace so users can control the permission level.

**Default allowed tools**: `Read,Glob,Grep,WebSearch,WebFetch` (read-only, safe)

**User can escalate to**: `Read,Glob,Grep,Edit,Write,Bash,WebSearch,WebFetch` (full access)

Implementation:
- Add `allowed_tools: Vec<String>` parameter to `agent::run_turn()`
- Pass `--allowedTools` flag to the CLI when non-empty
- Add a permission level selector in the chat UI header (e.g., "Read-only" / "Standard" / "Full access")
- Store the setting per workspace in the database

### Phase 2: Agent SDK integration (Future)

Replace the CLI subprocess with the Claude Agent SDK for full programmatic control:
- Real-time approve/deny per tool call
- Ability to modify tool inputs before execution
- No subprocess overhead
- Requires switching from Rust subprocess to either:
  - A Node.js sidecar running the Agent SDK
  - Or waiting for a Rust Agent SDK

This is a larger architectural change and should be tracked as a separate effort.

## Files to modify (Phase 1)

### Backend
- `src/agent.rs` — Add `allowed_tools` parameter to `run_turn()`, pass `--allowedTools` flag
- `src/db.rs` — Add workspace permission level storage (or use `app_settings`)
- `src-tauri/src/commands/chat.rs` — Pass allowed tools when spawning agent turn

### Frontend
- Chat header — Add permission level dropdown/toggle
- Store — Add permission level state per workspace
