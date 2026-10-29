-- Measured reading sessions exported to Readwise Books (POST /books/api/v1/sessions).
-- One row per device session once an export was attempted. Readwise returns its own
-- numeric session id; a checkpoint that later grows is deleted there and posted again.
-- Rows outlive an unlink so a re-link of the same account never posts a session twice.
CREATE TABLE readwise_books_session_exports (
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  remote_id INTEGER,
  exported_seconds INTEGER NOT NULL DEFAULT 0,
  exported_ended_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (user_id, device_id, session_id),
  FOREIGN KEY (user_id, device_id, session_id)
    REFERENCES reading_sessions(user_id, device_id, session_id) ON DELETE CASCADE
);
