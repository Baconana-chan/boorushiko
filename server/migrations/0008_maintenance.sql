-- Long-running maintenance bookkeeping. Stored in the database so a pm2
-- restart does not reset the daily/weekly schedule and re-run heavy work.
CREATE TABLE IF NOT EXISTS maintenance_runs (
  name TEXT PRIMARY KEY,
  last_started_at TEXT NOT NULL,
  last_finished_at TEXT,
  last_error TEXT
);
