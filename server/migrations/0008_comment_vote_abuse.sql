-- Anti-abuse data for comment votes. The action log is append-only and only
-- stores non-zero votes; removing a vote is always allowed and never counts
-- toward the daily quota.

ALTER TABLE comment_votes ADD COLUMN weight INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS comment_vote_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  comment_id INTEGER NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS comment_vote_actions_user_idx
  ON comment_vote_actions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS comment_vote_actions_created_idx
  ON comment_vote_actions (created_at);
