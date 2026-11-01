-- Moderation, reports, DNP policy and audit trail.

ALTER TABLE posts ADD COLUMN uploaded_by INTEGER REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN moderated_by INTEGER REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN moderated_at TEXT;
ALTER TABLE posts ADD COLUMN rejection_reason TEXT;
ALTER TABLE posts ADD COLUMN moderation_note TEXT;
ALTER TABLE posts ADD COLUMN policy_flags TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS posts_moderated_idx ON posts (moderated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id         INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  reporter_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  reason          TEXT NOT NULL CHECK (reason IN (
                    'ai', '3d', 'not_2d', 'duplicate', 'low_quality',
                    'banned_artist', 'copyright', 'metadata', 'other'
                  )),
  body            TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  created_at      TEXT NOT NULL,
  resolved_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  resolved_at     TEXT,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS reports_post_idx ON reports (post_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS reports_open_uq
  ON reports (post_id, reporter_id, reason)
  WHERE status = 'open' AND reporter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dnp_artists (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  source_pattern TEXT,
  note           TEXT,
  created_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS dnp_artists_name_uq ON dnp_artists (name);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   INTEGER,
  reason      TEXT,
  details     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  post_id    INTEGER REFERENCES posts (id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON notifications (user_id, read_at, created_at DESC);
