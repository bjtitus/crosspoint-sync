-- Genres set through PUT /api/v1/documents/:document/info stick over Hardcover lookups.
ALTER TABLE documents ADD COLUMN genres_manual INTEGER NOT NULL DEFAULT 0;
