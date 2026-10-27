-- Newest-first paging of GET /progress, /documents and a connector's review list: each page walks
-- the index from its cursor instead of sorting every book again.
CREATE INDEX idx_progress_recent ON progress(user_id, updated_at, document);
CREATE INDEX idx_documents_recent ON documents(user_id, updated_at, document);
