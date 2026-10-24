ALTER TABLE bookorbit_session_exports ADD COLUMN exported_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookorbit_session_exports ADD COLUMN payload TEXT;
CREATE UNIQUE INDEX bookorbit_session_remote_identity
  ON bookorbit_session_exports(user_id, destination, remote_id) WHERE remote_id IS NOT NULL;
