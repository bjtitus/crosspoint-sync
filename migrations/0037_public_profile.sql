-- Opt-in public reading profile at /u/<slug>. NULL = off. A random slug rather
-- than the username, since the username is half of the sync login.
ALTER TABLE users ADD COLUMN profile_slug TEXT;
CREATE UNIQUE INDEX users_profile_slug ON users(profile_slug);
