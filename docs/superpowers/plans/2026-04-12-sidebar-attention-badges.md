# Sidebar Attention Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic pulsing "●" notification dot in the sidebar with distinct, theme-aware badge icons (BadgeCheck/BadgeInfo/BadgeQuestionMark) for done, plan, and ask attention states.

**Architecture:** Three new CSS custom properties (`--badge-done`, `--badge-plan`, `--badge-ask`) added to the theme system. Badge state derived from existing Zustand store data (`unreadCompletions`, `planApprovals`, `agentQuestions`) with priority Ask > Plan > Done. No new store state or backend changes needed.

**Tech Stack:** React, TypeScript, lucide-react icons, CSS Modules, Zustand, CSS custom properties

**Spec:** `docs/superpowers/specs/2026-04-12-sidebar-attention-badges-design.md`

---

### Task 1: Add badge CSS variables to theme system

**Files:**
- Modify: `src/ui/src/styles/theme.css` (`:root` block, after line 35 `--status-stopped`)
- Modify: `src/ui/src/utils/theme.ts` (line 30, after `"status-stopped"` in `THEMEABLE_VARS`)

- [ ] **Step 1: Add CSS variables to theme.css**

In `src/ui/src/styles/theme.css`, add these three lines after the `--status-stopped` declaration (after line 35):

```css
  /* Attention badges */
  --badge-done: #00e5cc;
  --badge-plan: rgb(100, 160, 240);
  --badge-ask: #f0a050;
```

- [ ] **Step 2: Add variables to THEMEABLE_VARS in theme.ts**

In `src/ui/src/utils/theme.ts`, add three entries to the `THEMEABLE_VARS` array after `"status-stopped"` (after line 30):

```ts
  "badge-done",
  "badge-plan",
  "badge-ask",
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd src/ui && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/ui/src/styles/theme.css src/ui/src/utils/theme.ts
git commit -m "feat(ui): add badge-done/plan/ask CSS variables to theme system"
```

---

### Task 2: Add badge colors to all 12 theme JSON files

**Files:**
- Modify: `src/ui/src/styles/themes/default-dark.json`
- Modify: `src/ui/src/styles/themes/default-light.json`
- Modify: `src/ui/src/styles/themes/high-contrast.json`
- Modify: `src/ui/src/styles/themes/midnight-blue.json`
- Modify: `src/ui/src/styles/themes/warm-ember.json`
- Modify: `src/ui/src/styles/themes/rose-pine.json`
- Modify: `src/ui/src/styles/themes/rose-pine-moon.json`
- Modify: `src/ui/src/styles/themes/rose-pine-dawn.json`
- Modify: `src/ui/src/styles/themes/solarized-dark.json`
- Modify: `src/ui/src/styles/themes/solarized-light.json`
- Modify: `src/ui/src/styles/themes/jellybeans.json`
- Modify: `src/ui/src/styles/themes/jellybeans-muted.json`

Each theme file ends with `"shadow-card-hover": "..."` as the last property in the `"colors"` object. Add a comma after `shadow-card-hover`'s value, then add the three badge properties before the closing `}`.

- [ ] **Step 1: Update default-dark.json**

Add before the closing `}` of `"colors"`:
```json
    "badge-done": "#00e5cc",
    "badge-plan": "rgb(100, 160, 240)",
    "badge-ask": "#f0a050"
```

(Add a comma after the existing `shadow-card-hover` line.)

- [ ] **Step 2: Update default-light.json**

```json
    "badge-done": "#0969da",
    "badge-plan": "#8250df",
    "badge-ask": "#bf8700"
```

- [ ] **Step 3: Update high-contrast.json**

```json
    "badge-done": "#00ffdd",
    "badge-plan": "#66bbff",
    "badge-ask": "#ffbb44"
```

- [ ] **Step 4: Update midnight-blue.json**

```json
    "badge-done": "#4a9eff",
    "badge-plan": "rgb(100, 160, 240)",
    "badge-ask": "#f0a050"
```

- [ ] **Step 5: Update warm-ember.json**

```json
    "badge-done": "#50d8a0",
    "badge-plan": "rgb(120, 170, 230)",
    "badge-ask": "#f0a050"
```

- [ ] **Step 6: Update rose-pine.json**

```json
    "badge-done": "#9ccfd8",
    "badge-plan": "#c4a7e7",
    "badge-ask": "#f6c177"
```

- [ ] **Step 7: Update rose-pine-moon.json**

```json
    "badge-done": "#9ccfd8",
    "badge-plan": "#c4a7e7",
    "badge-ask": "#f6c177"
```

- [ ] **Step 8: Update rose-pine-dawn.json**

```json
    "badge-done": "#56949f",
    "badge-plan": "#907aa9",
    "badge-ask": "#ea9d34"
```

- [ ] **Step 9: Update solarized-dark.json**

```json
    "badge-done": "#2aa198",
    "badge-plan": "#268bd2",
    "badge-ask": "#b58900"
```

- [ ] **Step 10: Update solarized-light.json**

```json
    "badge-done": "#2aa198",
    "badge-plan": "#268bd2",
    "badge-ask": "#b58900"
```

- [ ] **Step 11: Update jellybeans.json**

```json
    "badge-done": "#99ad6a",
    "badge-plan": "#8fbfdc",
    "badge-ask": "#fad07a"
```

- [ ] **Step 12: Update jellybeans-muted.json**

```json
    "badge-done": "#829868",
    "badge-plan": "#7aa8c0",
    "badge-ask": "#d4b880"
```

- [ ] **Step 13: Validate all JSON files parse**

Run: `cd src/ui && for f in src/styles/themes/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" && echo "OK: $f" || echo "FAIL: $f"; done`
Expected: All 12 files print "OK"

- [ ] **Step 14: Commit**

```bash
git add src/ui/src/styles/themes/
git commit -m "feat(ui): add badge colors to all 12 theme files"
```

---

### Task 3: Add badge CSS classes to Sidebar.module.css

**Files:**
- Modify: `src/ui/src/components/sidebar/Sidebar.module.css`

- [ ] **Step 1: Replace .notificationBadge with badge classes**

In `src/ui/src/components/sidebar/Sidebar.module.css`, find and remove the `.notificationBadge` block (lines 257-263):

```css
.notificationBadge {
  color: var(--accent-primary);
  font-size: 16px;
  line-height: 1;
  animation: pulse-badge 2s ease-in-out infinite;
  flex-shrink: 0;
}
```

Replace it with three new badge classes:

```css
.badgeDone,
.badgePlan,
.badgeAsk {
  flex-shrink: 0;
  animation: pulse-badge 2s ease-in-out infinite;
}

.badgeDone {
  color: var(--badge-done);
}

.badgePlan {
  color: var(--badge-plan);
}

.badgeAsk {
  color: var(--badge-ask);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/src/components/sidebar/Sidebar.module.css
git commit -m "feat(ui): add badge CSS classes for done/plan/ask attention states"
```

---

### Task 4: Update Sidebar.tsx to render attention badges

**Files:**
- Modify: `src/ui/src/components/sidebar/Sidebar.tsx`

- [ ] **Step 1: Add lucide-react icon imports**

On line 16, update the lucide-react import to include the three badge icons:

Change:
```tsx
import { Settings, Link, X, Share2, Plus, Globe, Archive, Trash2 } from "lucide-react";
```

To:
```tsx
import { Settings, Link, X, Share2, Plus, Globe, Archive, Trash2, BadgeCheck, BadgeInfo, BadgeQuestionMark } from "lucide-react";
```

- [ ] **Step 2: Add store subscriptions for agentQuestions and planApprovals**

After line 35 (`const unreadCompletions = useAppStore((s) => s.unreadCompletions);`), add:

```tsx
  const agentQuestions = useAppStore((s) => s.agentQuestions);
  const planApprovals = useAppStore((s) => s.planApprovals);
```

- [ ] **Step 3: Replace badge derivation and rendering logic**

Find the workspace map block starting at line 325. Replace the `hasUnread` derivation and the rendering that uses it.

Change this block (lines 325-336):
```tsx
                repoWorkspaces.map((ws) => {
                  const hasUnread = unreadCompletions.has(ws.id);
                  return (
                  <div
                    key={ws.id}
                    className={`${styles.wsItem} ${selectedWorkspaceId === ws.id ? styles.wsSelected : ""} ${hasUnread ? styles.wsUnread : ""}`}
                    onClick={() => {
                      selectWorkspace(ws.id);
                      if (hasUnread) {
                        clearUnreadCompletion(ws.id);
                      }
                    }}
                  >
```

To:
```tsx
                repoWorkspaces.map((ws) => {
                  const badge: "ask" | "plan" | "done" | null =
                    agentQuestions[ws.id] ? "ask" :
                    planApprovals[ws.id] ? "plan" :
                    unreadCompletions.has(ws.id) && ws.agent_status !== "Running" ? "done" :
                    null;
                  return (
                  <div
                    key={ws.id}
                    className={`${styles.wsItem} ${selectedWorkspaceId === ws.id ? styles.wsSelected : ""} ${badge ? styles.wsUnread : ""}`}
                    onClick={() => {
                      selectWorkspace(ws.id);
                    }}
                  >
```

- [ ] **Step 4: Replace the notification badge icon rendering**

Find this line (currently line 352):
```tsx
                        {hasUnread && <span className={styles.notificationBadge}>●</span>}
```

Replace with:
```tsx
                        {badge === "done" && <BadgeCheck size={14} className={styles.badgeDone} />}
                        {badge === "plan" && <BadgeInfo size={14} className={styles.badgePlan} />}
                        {badge === "ask" && <BadgeQuestionMark size={14} className={styles.badgeAsk} />}
```

- [ ] **Step 5: Remove unused clearUnreadCompletion subscription**

Find and remove line 47:
```tsx
  const clearUnreadCompletion = useAppStore((s) => s.clearUnreadCompletion);
```

Note: `clearUnreadCompletion` is still used in the store by other code (e.g., when agent starts running). We're only removing the sidebar's subscription to it since the sidebar no longer calls it.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd src/ui && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Verify frontend builds**

Run: `cd src/ui && bun run build`
Expected: Build succeeds with no errors

- [ ] **Step 8: Commit**

```bash
git add src/ui/src/components/sidebar/Sidebar.tsx
git commit -m "feat(ui): render themed attention badges in sidebar workspace items"
```
