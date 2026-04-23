ALTER TABLE workspaces ADD COLUMN branch_auto_rename_claimed INTEGER NOT NULL DEFAULT 0;

UPDATE workspaces SET branch_auto_rename_claimed = 1
  WHERE id IN (SELECT DISTINCT workspace_id FROM chat_messages);
