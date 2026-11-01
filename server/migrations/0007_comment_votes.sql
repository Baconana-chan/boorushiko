-- Community scoring for comments. Comment scores decide whether a comment is
-- collapsed; user karma is derived from the same scores and never changes
-- visibility by itself.

ALTER TABLE comments ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN vote_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS comment_votes (
  comment_id INTEGER NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);

CREATE INDEX IF NOT EXISTS comment_votes_user_idx ON comment_votes (user_id, updated_at DESC);
