-- Per-repo declared inputs (JSON array of {type,key,label,...}) and the
-- values a specific workspace was created with (JSON object {key:string}).
-- Both nullable: a repo without declared inputs leaves NULL; a workspace
-- whose repo has no inputs leaves NULL.
ALTER TABLE repositories ADD COLUMN required_inputs TEXT;
ALTER TABLE workspaces ADD COLUMN input_values TEXT;
