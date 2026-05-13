# UAT Recipes

Ready-to-use JS expressions for common UAT verification tasks.
All run via `${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh`.

## Verify tool call summaries after a turn

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
const wsId = s.selectedWorkspaceId;
const turns = s.completedTurns[wsId] || [];
const t = turns[turns.length - 1];
if (!t) return 'no completed turns';
return {
  acts: t.activities.length,
  jsonAllValid: t.activities.every(a => { try { JSON.parse(a.inputJson); return true } catch { return false } }),
  summariesPresent: t.activities.filter(a => a.summary).length,
  samples: t.activities.slice(0, 5).map(a => a.toolName + ': ' + (a.summary || '(empty)')),
};
JS
```

## Verify no doubled streaming content

Checks if any assistant message has its first quarter repeated in the second quarter (a sign of double-append bugs).

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
const wsId = s.selectedWorkspaceId;
const msgs = s.chatMessages[wsId] || [];
const doubled = msgs.filter(m => m.role === 'Assistant' && m.content.length > 40).find(m => {
  const q = Math.floor(m.content.length / 4);
  return m.content.substring(0, q) === m.content.substring(q, q * 2);
});
return doubled ? { doubled: true, preview: doubled.content.substring(0, 80) } : { doubled: false };
JS
```

## Check scroll position

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const c = document.querySelector('[class*="messages_"]');
if (!c) return 'no container';
return {
  atBottom: c.scrollHeight - c.scrollTop - c.clientHeight < 50,
  gap: Math.round(c.scrollHeight - c.scrollTop - c.clientHeight),
};
JS
```

## Full post-turn verification

Combines tool summaries, doubled content check, scroll position, and message integrity into one eval.

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
const wsId = s.selectedWorkspaceId;
const msgs = s.chatMessages[wsId] || [];
const turns = s.completedTurns[wsId] || [];
const c = document.querySelector('[class*="messages_"]');

const lastTurn = turns[turns.length - 1];
const doubled = msgs.filter(m => m.role === 'Assistant' && m.content.length > 40).find(m => {
  const q = Math.floor(m.content.length / 4);
  return m.content.substring(0, q) === m.content.substring(q, q * 2);
});

return {
  messages: msgs.length,
  turns: turns.length,
  lastTurnTools: lastTurn ? lastTurn.activities.length : 0,
  allJsonValid: turns.every(t => t.activities.every(a => { try { JSON.parse(a.inputJson); return true } catch { return false } })),
  allSummariesPresent: turns.every(t => t.activities.every(a => !!a.summary)),
  doubledContent: !!doubled,
  scrollGap: c ? Math.round(c.scrollHeight - c.scrollTop - c.clientHeight) : -1,
  streamingCleared: (s.streamingContent[wsId] || '') === '',
  toolActivitiesFlushed: (s.toolActivities[wsId] || []).length === 0,
};
JS
```

## Read all messages for a workspace

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const s = window.__CLAUDETTE_STORE__.getState();
const wsId = s.selectedWorkspaceId;
return (s.chatMessages[wsId] || []).map((m, i) => ({
  idx: i,
  role: m.role,
  len: m.content?.length,
  preview: m.content?.substring(0, 150)
}));
JS
```

## Inspect DOM message structure

```bash
${CLAUDE_SKILL_DIR}/scripts/debug-eval.sh <<'JS'
const c = document.querySelector('[class*="messages_"]');
if (!c) return 'no container';
return Array.from(c.children).map((el, i) => ({
  idx: i,
  cls: el.className?.substring(0, 50),
  text: el.textContent?.substring(0, 120)
}));
JS
```
