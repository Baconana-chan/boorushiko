-- Favorites, pools and post relationships. Kept in one migration because they
-- are the three "collection" features of a booru and share the same review round.

CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS favorites_post_idx ON favorites (post_id);
CREATE INDEX IF NOT EXISTS favorites_user_idx ON favorites (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'series',
  is_public   INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_posts (
  pool_id  INTEGER NOT NULL REFERENCES pools (id) ON DELETE CASCADE,
  post_id  INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  PRIMARY KEY (pool_id, post_id)
);

CREATE INDEX IF NOT EXISTS pool_posts_order_idx ON pool_posts (pool_id, position, post_id);

-- Parent/child: a crop, a higher-resolution rescan or an alternate version of
-- the same work links back to its parent instead of being a duplicate.
ALTER TABLE posts ADD COLUMN parent_id INTEGER REFERENCES posts (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS posts_parent_idx ON posts (parent_id);
