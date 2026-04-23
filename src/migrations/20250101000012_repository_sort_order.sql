ALTER TABLE repositories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE repositories SET sort_order = (
    SELECT COUNT(*) FROM repositories r2 WHERE r2.name < repositories.name
);
