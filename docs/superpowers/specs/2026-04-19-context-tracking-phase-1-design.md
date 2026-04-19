# Context Window Tracking — Phase 1: Token Usage Plumbing

## Context

Claudette currently tracks cost and duration per turn but has no visibility into context window utilization. The Claude CLI's `stream-json` output already carries token usage in `message_delta` and `result` events — we just don't parse it. As a result, Claudette can't power a context meter, can't warn on approaching limits, and can't detect compaction.

This is the first of three stacked PRs implementing [issue #300](https://github.com/utensils/claudette/issues/300):

- **Phase 1 (this spec):** parse token usage, persist it per message, surface a minimal per-message readout.
- **Phase 2 (later):** workspace-level context utilization meter in the chat toolbar.
- **Phase 3 (later):** compaction detection, system event bridging, and timeline divider.

Phase 1 is shippable in isolation: it gives users per-message token counts today and establishes the data shape that Phases 2 and 3 will consume without further schema churn.

## Design

### 1. CLI event parsing (`src/agent.rs`)

Add a `TokenUsage` struct matching the CLI's `usage` shape:

```rust
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
}
```

Extend two existing events to carry it:

- **`StreamEvent::Result`** — add `usage: Option<TokenUsage>`. Turn-total snapshot emitted once at turn end. Symmetric with the existing `total_cost_usd` / `duration_ms` fields.
- **`InnerStreamEvent::MessageDelta`** — replace today's empty `MessageDelta {}` variant with `MessageDelta { usage: Option<TokenUsage> }`. Cumulative per-message count; the CLI updates it as streaming progresses, and the final delta before `message_stop` carries the authoritative per-message total.

**Why both sources:** `message_delta` gives per-message attribution (needed for the Phase 1 per-message readout); `Result` gives the turn total (needed by Phase 2's context meter). Parsing both now means Phase 2 touches the store and UI only.

### 2. ChatMessage extension (`src/model/chat_message.rs`)

Add four nullable `i64` fields, symmetric with the existing `cost_usd` / `duration_ms`:

```rust
pub input_tokens: Option<i64>,
pub output_tokens: Option<i64>,
pub cache_read_tokens: Option<i64>,
pub cache_creation_tokens: Option<i64>,
```

All four are `Option<i64>` because (a) historical messages won't have them, and (b) cache tokens are independently optional in the CLI output. SQLite stores these as nullable INTEGER.

### 3. Database migration (`src/db.rs`)

Bump `PRAGMA user_version` from 19 → 20. Migration uses the existing single-batch `execute_batch()` pattern:

```sql
ALTER TABLE chat_messages ADD COLUMN input_tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN output_tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE chat_messages ADD COLUMN cache_creation_tokens INTEGER;
```

Update `insert_chat_message()` to write all four columns (NULL for old inserts that don't carry usage — no change to existing callers' behavior, just wider row shape). Update the read path / row-mapping code to parse the four new columns into the extended struct.

### 4. Bridge task (`src-tauri/src/commands/chat.rs`)

Two surgical changes — the existing `update_chat_message_cost` is **not renamed**; cost/duration remain its responsibility:

1. **Persist per-message tokens on the INSERT path.** The bridge already accumulates streaming content per assistant message; add a `latest_usage: Option<TokenUsage>` local that gets overwritten on each `MessageDelta` with `usage`. When the assistant message is finalized, pass the stashed usage into `insert_chat_message` alongside content and thinking. `insert_chat_message`'s signature grows by four `Option<i64>` parameters.
2. **Parse Result's usage and forward live.** Extract `usage` from `StreamEvent::Result` and include it in the `AgentEvent` payload emitted to the frontend (so Phase 2 can consume live turn-totals from the store). **Do not** stamp it onto `chat_messages` in Phase 1. Per-message counts from step 1 are the DB's granularity; turn-totals for historical sessions are derivable by summing per-message counts, and live turn-totals reach the frontend via the Tauri event. This keeps `update_chat_message_cost` focused on cost/duration and avoids overwriting the final message's per-message counts.

### 5. Frontend type mirror (`src/ui/src/types/chat.ts`)

Extend the frontend `ChatMessage` interface with the same four nullable fields. No other frontend type changes in Phase 1.

### 6. Minimal per-message readout

The existing chat UI already renders a metadata line on assistant messages showing cost and duration. Extend that line to prepend a token segment when `input_tokens` or `output_tokens` is non-null:

```
1.2k in · 240 out · $0.003 · 2.1s
```

Rules:

- Format: numbers < 1000 render raw (`999`); >= 1000 render as `1.2k` with one decimal place.
- Omit the token segment entirely when both `input_tokens` and `output_tokens` are null — preserves the existing rendering for historical messages.
- Cache tokens (`cache_read_tokens`, `cache_creation_tokens`) are **persisted but not displayed** in Phase 1. Their natural home is a tooltip on the Phase 2 context meter, where cache-hit ratio is more interpretable than next to per-message output counts.

### 7. Out of scope

Phase 1 deliberately excludes:

- Context meter UI and capacity thresholds (Phase 2).
- Per-model context-window capacity metadata (Phase 2).
- Per-workspace cumulative context usage slice in Zustand (Phase 2).
- Compaction event parsing, system event bridging beyond the existing `init` branch, compaction timeline divider (Phase 3).
- Any change to how cost/duration are rendered.
- A visible cache-token readout.

## Testing

**Rust:**

- `src/agent.rs` unit tests: deserialize a `message_delta` payload with full usage; deserialize a `result` payload with usage; deserialize a `result` with only `input_tokens`/`output_tokens` (cache fields absent); deserialize a legacy payload with no `usage` key at all (must remain valid, `usage: None`).
- `src/db.rs` test: migration from v19 → v20 preserves existing `chat_messages` rows; insert + fetch a `ChatMessage` with all four token fields populated; insert + fetch with token fields NULL.

**Frontend (vitest):**

- Render an assistant message with `input_tokens`/`output_tokens` populated — readout contains the token segment.
- Render with both null — readout omits the token segment entirely.
- Formatting: `1234 → "1.2k"`, `999 → "999"`, `0 → "0"`.

## Risks

- **CLI format drift.** If the CLI changes its `usage` field names, parsing breaks silently (all optional). Mitigated by making `TokenUsage` fields strict for `input_tokens`/`output_tokens` (required when the struct is present) and permissive via `#[serde(default)]` for the cache fields.
- **Migration on a live database.** Adding nullable columns via `ALTER TABLE` is non-destructive and fast in SQLite — no row rewrite. Tested by the migration test.
- **Inconsistent Result vs message_delta totals.** These *should* agree for single-message turns and diverge for multi-message turns. Phase 1 persists both; any downstream consumer (Phase 2 meter) decides which to use. No reconciliation logic needed in Phase 1.

## Success Criteria

1. Opening an existing workspace after migration shows no errors; historical messages render without the token segment.
2. Sending a new message produces an assistant reply whose metadata row shows `Nk in · N out` alongside cost and duration.
3. Backend tests pass; frontend tests pass; `cargo clippy --workspace --all-targets` clean; `bunx tsc --noEmit` clean.
4. Phase 2 (future PR) can build a context meter consuming the new fields without further backend changes.
