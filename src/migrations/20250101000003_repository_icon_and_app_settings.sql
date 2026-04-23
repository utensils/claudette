ALTER TABLE repositories ADD COLUMN icon TEXT;
ALTER TABLE repositories ADD COLUMN path_slug TEXT;
UPDATE repositories SET path_slug = name WHERE path_slug IS NULL;

CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
