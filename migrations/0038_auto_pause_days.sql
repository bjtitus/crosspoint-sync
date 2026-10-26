-- Days without progress before a book in progress is auto-paused. NULL = the
-- default (AUTO_PAUSE_DAYS), 0 = never.
ALTER TABLE users ADD COLUMN auto_pause_days INTEGER;
