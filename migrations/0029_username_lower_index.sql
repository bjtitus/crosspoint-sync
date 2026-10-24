-- Username lookups are case-insensitive (lower(username) = ...); keep them indexed.
CREATE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
