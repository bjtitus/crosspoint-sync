-- Per-book local calendar-day counters: stats_device_day, one row set per book.
CREATE TABLE stats_device_book_day (
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL,
  document TEXT NOT NULL,
  date TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK(seconds >= 0 AND seconds <= 4294967295),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, document, date)
);
CREATE INDEX stats_device_book_day_document ON stats_device_book_day (user_id, document);
