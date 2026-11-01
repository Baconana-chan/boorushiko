-- Boorushiko core schema.
-- Timestamps are ISO-8601 strings (UTC) for easy comparison and JSON output.

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  storage_kind  TEXT NOT NULL DEFAULT 'hosted' CHECK (storage_kind IN ('remote', 'hosted')),
  md5           TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  mime          TEXT NOT NULL,
  ext           TEXT NOT NULL,
  width         INTEGER NOT NULL DEFAULT 0,
  height        INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL,
  rating        TEXT NOT NULL DEFAULT 's' CHECK (rating IN ('s', 'q', 'e')),
  score         INTEGER NOT NULL DEFAULT 0,
  source_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'hidden', 'deleted')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS posts_md5_uq ON posts (md5);
CREATE INDEX IF NOT EXISTS posts_created_idx ON posts (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS posts_status_created_idx ON posts (status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'artist', 'character', 'copyright', 'species', 'meta')),
  post_count  INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_name_uq ON tags (name);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id  INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

CREATE INDEX IF NOT EXISTS post_tags_tag_idx ON post_tags (tag_id, post_id);

CREATE TABLE IF NOT EXISTS post_sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id         INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  host            TEXT NOT NULL,
  remote_id       TEXT,
  url             TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'serve' CHECK (role IN ('serve', 'archive')),
  format          TEXT,
  width           INTEGER,
  height          INTEGER,
  bytes           INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'dead', 'rejected')),
  priority        INTEGER NOT NULL DEFAULT 1,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS post_sources_post_idx ON post_sources (post_id, status, priority);
CREATE INDEX IF NOT EXISTS post_sources_host_idx ON post_sources (host, status);

CREATE TABLE IF NOT EXISTS post_variants (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id  INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('thumb300', 'delivery')),
  url      TEXT,
  width    INTEGER,
  height   INTEGER,
  bytes    INTEGER,
  format   TEXT,
  quality  INTEGER
);

CREATE INDEX IF NOT EXISTS post_variants_post_idx ON post_variants (post_id, kind);

CREATE TABLE IF NOT EXISTS post_origins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id        INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,
  page_url       TEXT,
  file_url       TEXT NOT NULL,
  preview_url    TEXT,
  referer_policy TEXT,
  status         TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'source_dead')),
  checked_at     TEXT
);

CREATE INDEX IF NOT EXISTS post_origins_post_idx ON post_origins (post_id);

CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  run_at     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  locked_at  TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (run_at) WHERE locked_at IS NULL;
