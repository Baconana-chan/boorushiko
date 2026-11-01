-- Parser runs are long (Danbooru asks for ~1 request/sec), so they live in their
-- own queue and write progress to SQLite for the admin UI to poll.

CREATE TABLE IF NOT EXISTS source_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source           TEXT NOT NULL,
  tags             TEXT,
  limit_count      INTEGER NOT NULL,
  page             INTEGER NOT NULL DEFAULT 1,
  page_size        INTEGER NOT NULL DEFAULT 50,
  delay_ms         INTEGER NOT NULL DEFAULT 1100,
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  imported         INTEGER NOT NULL DEFAULT 0,
  duplicates       INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  seen             INTEGER NOT NULL DEFAULT 0,
  pages            INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT
);

CREATE INDEX IF NOT EXISTS source_runs_created_idx ON source_runs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS source_runs_status_idx ON source_runs (status, created_at ASC);

CREATE TABLE IF NOT EXISTS source_run_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES source_runs (id) ON DELETE CASCADE,
  level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS source_run_logs_run_idx ON source_run_logs (run_id, id);
