-- Keep provider sessions separate from cumulative device counters. A complete
-- generation replaces the previous import, including edited/deleted sessions.
CREATE TABLE bookorbit_stats_sync (
  user_id INTEGER NOT NULL,
  connector_id TEXT NOT NULL DEFAULT 'bookorbit' CHECK (connector_id = 'bookorbit'),
  external_id TEXT NOT NULL,
  active_generation INTEGER NOT NULL DEFAULT 0,
  next_page INTEGER NOT NULL DEFAULT 1,
  expected_total INTEGER,
  cutoff TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  refreshed_at INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, external_id),
  FOREIGN KEY (user_id, connector_id) REFERENCES connector_accounts(user_id, connector_id) ON DELETE CASCADE
);

CREATE TABLE bookorbit_stats_sessions (
  user_id INTEGER NOT NULL,
  external_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  source TEXT,
  PRIMARY KEY (user_id, external_id, generation, session_id),
  FOREIGN KEY (user_id, external_id) REFERENCES bookorbit_stats_sync(user_id, external_id) ON DELETE CASCADE
);
