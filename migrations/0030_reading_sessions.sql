-- Device sessions supplement existing counters; they are never added to those
-- counters again. Keep export identities across connector unlink/relink.
CREATE TABLE reading_sessions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  document TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  utc_offset_minutes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, session_id)
);
CREATE TABLE bookorbit_session_destination (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  destination TEXT NOT NULL
);
CREATE TABLE bookorbit_session_exports (
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  export_id TEXT NOT NULL UNIQUE,
  external_id TEXT,
  file_id TEXT,
  -- IDs already present before our first POST must never be mistaken for ours.
  prior_ids TEXT,
  remote_id INTEGER,
  attempted_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (user_id, device_id, session_id, destination),
  FOREIGN KEY (user_id, device_id, session_id)
    REFERENCES reading_sessions(user_id, device_id, session_id) ON DELETE CASCADE
);
