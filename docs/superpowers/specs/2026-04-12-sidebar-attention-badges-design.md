# Sidebar Attention Badges

## Context

When an agent finishes work, has a plan for review, or asks a question, the sidebar needs to draw attention to that workspace beyond just a notification. Currently, all three states show the same generic pulsing "●" dot. This change replaces that with distinct, themed badge icons so users can see at a glance what kind of attention is needed.

## Design

### Badge States

Three attention states, displayed as lucide-react icons next to the workspace name:

| State | Trigger | Icon | Color Var | Meaning |
|-------|---------|------|-----------|---------|
| **Done** | `unreadCompletions.has(wsId)` AND agent not Running | `BadgeCheck` | `--badge-done` | Agent finished, changes to review |
| **Plan** | `planApprovals[wsId]` exists | `BadgeInfo` | `--badge-plan` | Plan awaiting approval |
| **Ask** | `agentQuestions[wsId]` exists | `BadgeQuestionMark` | `--badge-ask` | Agent has a question |

**Priority** (when multiple states overlap): Ask > Plan > Done. Only one badge shows at a time.

### Visual Treatment

- **Bold**: Workspace name gets `font-weight: 700` when any badge is active (reuses existing `.wsUnread` class)
- **Icon**: 14px lucide icon rendered in the existing status-dot position before `.wsInfo`
- **Color**: Each badge uses its own CSS variable, themed per-palette
- **Animation**: All badges pulse using existing `pulse-badge` keyframes (2s ease-in-out infinite)

### Clearing Behavior

Badges persist until the agent state actually changes — they do **not** clear on workspace click:
- **Done**: Clears when agent starts running again
- **Plan**: Clears when user approves/dismisses the plan (`clearPlanApproval`)
- **Ask**: Clears when user answers the question (`clearAgentQuestion`)

The current `clearUnreadCompletion(ws.id)` call in the sidebar click handler is removed.

## Implementation

### Files Changed

1. **`src/ui/src/styles/theme.css`** — Add to `:root`:
   ```css
   --badge-done: #00e5cc;
   --badge-plan: rgb(100, 160, 240);
   --badge-ask: #f0a050;
   ```

2. **`src/ui/src/utils/theme.ts`** — Add to `THEMEABLE_VARS`:
   ```ts
   "badge-done",
   "badge-plan",
   "badge-ask",
   ```

3. **`src/ui/src/styles/themes/*.json`** (×12) — Add badge colors tuned to each palette:

   | Theme | `badge-done` | `badge-plan` | `badge-ask` |
   |-------|-------------|-------------|-------------|
   | default-dark | `#00e5cc` | `rgb(100, 160, 240)` | `#f0a050` |
   | default-light | `#0969da` | `#8250df` | `#bf8700` |
   | high-contrast | `#00ffdd` | `#66bbff` | `#ffbb44` |
   | midnight-blue | `#4a9eff` | `rgb(100, 160, 240)` | `#f0a050` |
   | warm-ember | `#50d8a0` | `rgb(120, 170, 230)` | `#f0a050` |
   | rose-pine | `#9ccfd8` | `#c4a7e7` | `#f6c177` |
   | rose-pine-moon | `#9ccfd8` | `#c4a7e7` | `#f6c177` |
   | rose-pine-dawn | `#56949f` | `#907aa9` | `#ea9d34` |
   | solarized-dark | `#2aa198` | `#268bd2` | `#b58900` |
   | solarized-light | `#2aa198` | `#268bd2` | `#b58900` |
   | jellybeans | `#99ad6a` | `#8fbfdc` | `#fad07a` |
   | jellybeans-muted | `#829868` | `#7aa8c0` | `#d4b880` |

4. **`src/ui/src/components/sidebar/Sidebar.module.css`**:
   - Remove `.notificationBadge` class
   - Add `.badgeDone`, `.badgePlan`, `.badgeAsk` classes (shared base with `flex-shrink: 0` and `pulse-badge` animation, each colored by its CSS var)

5. **`src/ui/src/components/sidebar/Sidebar.tsx`**:
   - Import `BadgeCheck`, `BadgeInfo`, `BadgeQuestionMark` from lucide-react
   - Subscribe to `agentQuestions` and `planApprovals` from store
   - Derive badge state per workspace: `ask | plan | done | null`
   - Replace `{hasUnread && <span className={styles.notificationBadge}>●</span>}` with conditional icon rendering
   - Apply `.wsUnread` based on `badge !== null` instead of `hasUnread`
   - Remove `clearUnreadCompletion` from click handler

### No Store Changes

All needed state already exists: `agentQuestions`, `planApprovals`, `unreadCompletions`, `agent_status`.

## Verification

1. Run `cd src/ui && bunx tsc --noEmit` — TypeScript compiles
2. Run `cd src/ui && bun run build` — Frontend builds
3. Run `cargo tauri dev` — App launches, sidebar renders
4. Manual: trigger each badge state and verify correct icon/color/bold
5. Manual: switch themes and verify badge colors update
6. Manual: verify badges persist on click, clear on agent state change
