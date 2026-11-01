-- Automatic source imports keep two watermarks per source:
--   head_id  — newest imported post id, polled with `id:>head_id order:id`;
--   cursor   — oldest imported post id, walked backwards for the archive.
-- Alternating head/backfill runs keeps new posts flowing in without re-reading
-- the same page forever.

ALTER TABLE source_runs ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE source_runs ADD COLUMN since_id TEXT;
ALTER TABLE source_runs ADD COLUMN cursor TEXT;
ALTER TABLE source_runs ADD COLUMN newest_origin_id TEXT;
ALTER TABLE source_runs ADD COLUMN next_cursor TEXT;

CREATE TABLE IF NOT EXISTS source_schedules (
  source           TEXT PRIMARY KEY,
  enabled          INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  batch_limit      INTEGER NOT NULL DEFAULT 20,
  daily_limit      INTEGER NOT NULL DEFAULT 300,
  tags             TEXT,
  next_mode        TEXT NOT NULL DEFAULT 'head',
  head_id          TEXT,
  cursor           TEXT,
  backfill_done    INTEGER NOT NULL DEFAULT 0,
  next_run_at      TEXT NOT NULL,
  last_run_at      TEXT,
  last_error       TEXT,
  failure_count    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS source_schedules_due_idx
  ON source_schedules (enabled, next_run_at);
