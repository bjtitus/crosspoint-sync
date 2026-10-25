-- Book details set through PUT /api/v1/documents/:document/info stick over Hardcover lookups, as genres
-- do since 0033. series_manual covers series, series_position and hc_series_id together.
ALTER TABLE documents ADD COLUMN moods_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN content_warnings_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN description_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN series_manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN release_year_manual INTEGER NOT NULL DEFAULT 0;
