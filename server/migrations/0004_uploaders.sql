-- Approved uploaders and their applications. Staff (moderator/admin) can upload
-- without a row here; this table only grants the privilege to regular members.

CREATE TABLE IF NOT EXISTS uploaders (
  user_id     INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  approved_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  approved_at TEXT NOT NULL,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS uploader_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message     TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at  TEXT NOT NULL,
  reviewed_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at TEXT,
  review_note TEXT
);

-- One open application per member; rejected members may apply again.
CREATE UNIQUE INDEX IF NOT EXISTS uploader_requests_pending_uq
  ON uploader_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS uploader_requests_status_idx
  ON uploader_requests (status, created_at DESC);
