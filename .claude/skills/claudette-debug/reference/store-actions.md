# Zustand Store Actions Reference

All actions are on `window.__CLAUDETTE_STORE__.getState()`.

**Tip**: Use `discover actions` for the live, always-current list extracted from the running app.

## Repository

- `setRepositories(repos)` -- replace entire repository list
- `addRepository(repo)` -- append a repository
- `updateRepository(id, updates)` -- partial update repository properties
- `removeRepository(id)` -- delete repository and cascade remove workspaces

## Workspace

- `setWorkspaces(workspaces)` -- replace entire workspace list
- `addWorkspace(ws)` -- append a workspace
- `updateWorkspace(id, updates)` -- partial update workspace properties
- `removeWorkspace(id)` -- delete workspace, clear selection if active
- `selectWorkspace(id)` -- set active workspace (id or null)

## Chat Messages

- `setChatMessages(wsId, messages)` -- replace chat history for workspace
- `addChatMessage(wsId, message)` -- append message, update lastMessages
- `setStreamingContent(wsId, content)` -- replace streaming content
- `appendStreamingContent(wsId, text)` -- append to streaming content

## Tool Activities

- `setToolActivities(wsId, activities)` -- replace tool activity list
- `addToolActivity(wsId, activity)` -- append tool activity
- `updateToolActivity(wsId, toolUseId, updates)` -- partial update activity
- `toggleToolActivityCollapsed(wsId, index)` -- toggle collapse
- `appendToolActivityInput(wsId, toolUseId, partialJson)` -- append JSON input

## Completed Turns

- `finalizeTurn(wsId, messageCount, turnId?)` -- move tool activities to completed turns
- `hydrateCompletedTurns(wsId, turns)` -- merge incoming turns, preserving collapse state
- `setCompletedTurns(wsId, turns)` -- replace completed turns
- `toggleCompletedTurn(wsId, turnIndex)` -- toggle turn collapse

## Agent Questions

- `setAgentQuestion(q)` -- store question `{ workspaceId, toolUseId, questions }`
- `clearAgentQuestion(wsId)` -- remove question

## Plan Approvals

- `setPlanApproval(p)` -- store approval `{ workspaceId, toolUseId, planFilePath, allowedPrompts }`
- `clearPlanApproval(wsId)` -- remove approval

## Queued Messages

- `setQueuedMessage(wsId, content)` -- queue message for later dispatch
- `clearQueuedMessage(wsId)` -- dequeue

## Checkpoints

- `setCheckpoints(wsId, cps)` -- replace checkpoint list
- `addCheckpoint(wsId, cp)` -- append checkpoint
- `rollbackConversation(wsId, checkpointId, messages)` -- restore to checkpoint

## Notifications

- `markWorkspaceAsUnread(wsId)` -- add to unread set
- `clearUnreadCompletion(wsId)` -- remove from unread set

## Permissions

- `setPermissionLevel(wsId, level)` -- set permission level per workspace

## Toolbar / Per-Workspace Settings

- `setSelectedModel(wsId, model)` -- set model
- `setFastMode(wsId, enabled)` -- toggle fast mode
- `setThinkingEnabled(wsId, enabled)` -- toggle thinking
- `setPlanMode(wsId, enabled)` -- toggle plan mode
- `setModelSelectorOpen(open)` -- model selector visibility

## Diff

- `setDiffFiles(files, mergeBase)` -- load diff file list (note: two params)
- `setDiffSelectedFile(path)` -- select file (path or null)
- `setDiffContent(content)` -- load diff content (FileDiff or null)
- `setDiffViewMode(mode)` -- "Unified" or "Split"
- `setDiffLoading(loading)` -- boolean
- `setDiffError(error)` -- string or null
- `clearDiff()` -- reset all diff state

## Terminal

- `setTerminalTabs(wsId, tabs)` -- replace tab list
- `addTerminalTab(wsId, tab)` -- append tab, set active
- `removeTerminalTab(wsId, tabId)` -- delete tab, reassign active
- `setActiveTerminalTab(id)` -- set active tab (id or null)
- `toggleTerminalPanel()` -- show/hide terminal

## UI Layout

- `toggleSidebar()` -- show/hide left sidebar
- `toggleRightSidebar()` -- show/hide right sidebar
- `setSidebarWidth(w)` -- set left sidebar width
- `setRightSidebarWidth(w)` -- set right sidebar width
- `setTerminalHeight(h)` -- set terminal panel height
- `setSidebarGroupBy(g)` -- "status" or "repo"
- `setSidebarRepoFilter(id)` -- repo ID or "all"
- `setSidebarShowArchived(show)` -- bool
- `toggleRepoCollapsed(id)` -- toggle repository collapse
- `toggleStatusGroupCollapsed(key)` -- toggle status-bucket collapse
- `toggleFuzzyFinder()` -- show/hide fuzzy finder
- `toggleCommandPalette()` -- show/hide command palette
- `setMetaKeyHeld(held)` -- track meta key state

## Modals

- `openModal(name, data?)` -- open modal with optional data
- `closeModal()` -- close and clear

## Chat Input

- `setChatInputPrefill(text)` -- set prefill text (string or null)

## Settings

- `setWorktreeBaseDir(dir)` -- worktree base directory
- `setDefaultBranches(branches)` -- Record<repoId, branchName>
- `setTerminalFontSize(size)` -- 8-24
- `setAudioNotifications(enabled)` -- boolean
- `setCurrentThemeId(id)` -- theme identifier
- `setLastMessages(msgs)` -- Record<wsId, ChatMessage>

## Remote Connections

- `setRemoteConnections(conns)` -- replace list
- `addRemoteConnection(conn)` -- append
- `removeRemoteConnection(id)` -- delete, remove from active
- `setDiscoveredServers(servers)` -- update discovered list
- `setActiveRemoteIds(ids)` -- replace active IDs
- `addActiveRemoteId(id)` -- add (idempotent)
- `removeActiveRemoteId(id)` -- remove
- `mergeRemoteData(connectionId, data)` -- merge remote repos/workspaces
- `clearRemoteData(connectionId)` -- remove all data for connection

## Local Server

- `setLocalServerRunning(running)` -- boolean
- `setLocalServerConnectionString(cs)` -- string or null
