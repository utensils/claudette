# Tauri Commands Reference

All commands are invoked via `window.__CLAUDETTE_INVOKE__(commandName, { params })`.

**Parameter naming**: Rust `snake_case` parameters become JS `camelCase` keys automatically.
For example, `workspace_id: String` in Rust becomes `workspaceId` in the JS invoke call.

## Data

- `loadInitialData()` -> `InitialData { repositories, workspaces, worktree_base_dir, default_branches, last_messages }`

## Repository

- `addRepository(path)` -> `Repository`
- `updateRepositorySettings(id, name, icon?, setupScript?, customInstructions?)` -> void
- `relinkRepository(id, path)` -> void
- `removeRepository(id)` -> void
- `getRepoConfig(repoId)` -> `RepoConfigInfo`
- `getDefaultBranch(repoId)` -> `string | null`
- `reorderRepositories(ids)` -> void

## Workspace

- `createWorkspace(repoId, name)` -> `CreateWorkspaceResult { workspace, setup_result }`
- `archiveWorkspace(id)` -> void
- `restoreWorkspace(id)` -> `string` (worktree path)
- `deleteWorkspace(id)` -> void
- `generateWorkspaceName()` -> `GeneratedWorkspaceName { slug, display, message }`
- `refreshBranches()` -> `[string, string][]` (workspace_id, branch_name pairs)
- `openWorkspaceInTerminal(worktreePath)` -> void

## Slash Commands

- `listSlashCommands(projectPath?, workspaceId?)` -> `SlashCommand[]`
- `recordSlashCommandUsage(workspaceId, commandName)` -> void

## Chat

- `sendChatMessage(workspaceId, content, permissionLevel?, model?, fastMode?, thinkingEnabled?, planMode?)` -> void
- `loadChatHistory(workspaceId)` -> `ChatMessage[]`
- `stopAgent(workspaceId)` -> void
- `resetAgentSession(workspaceId)` -> void

## Checkpoints

- `listCheckpoints(workspaceId)` -> `ConversationCheckpoint[]`
- `rollbackToCheckpoint(workspaceId, checkpointId, restoreFiles)` -> `ChatMessage[]`
- `clearConversation(workspaceId, restoreFiles)` -> `ChatMessage[]`
- `saveTurnToolActivities(checkpointId, messageCount, activities)` -> void
- `loadCompletedTurns(workspaceId)` -> `CompletedTurnData[]`

## Plan

- `readPlanFile(path)` -> `string` (file content)

## Diff

- `loadDiffFiles(workspaceId)` -> `DiffFilesResult { files, merge_base }`
- `loadFileDiff(worktreePath, mergeBase, filePath)` -> `FileDiff`
- `computeWorkspaceMergeBase(workspaceId)` -> string  (lightweight: returns just the merge-base SHA, no file list)
- `revertFile(worktreePath, mergeBase, filePath, status)` -> void

## Terminal

- `createTerminalTab(workspaceId)` -> `TerminalTab`
- `deleteTerminalTab(id)` -> void
- `listTerminalTabs(workspaceId)` -> `TerminalTab[]`

## PTY

- `spawnPty(workingDir)` -> `number` (pty_id)
- `writePty(ptyId, data)` -> void
- `resizePty(ptyId, cols, rows)` -> void
- `closePty(ptyId)` -> void

## Settings

- `getAppSetting(key)` -> `string | null`
- `setAppSetting(key, value)` -> void
- `listUserThemes()` -> `ThemeDefinition[]`

## Remote

- `listRemoteConnections()` -> `RemoteConnectionInfo[]`
- `pairWithServer(host, port, pairingToken)` -> `PairResult`
- `connectRemote(id)` -> `RemoteInitialData | null`
- `disconnectRemote(id)` -> void
- `removeRemoteConnection(id)` -> void
- `listDiscoveredServers()` -> `DiscoveredServer[]`
- `addRemoteConnection(connectionString)` -> `PairResult`
- `sendRemoteCommand(connectionId, method, params)` -> `unknown`

## Local Server

- `startLocalServer()` -> `LocalServerInfo { running, connection_string }`
- `stopLocalServer()` -> void
- `getLocalServerStatus()` -> `LocalServerInfo`

## Debug (dev builds only)

- `debugEvalJs(js)` -> `string` (eval result)
- `debugEvalResult(requestId, data)` -> void (callback for eval results)
