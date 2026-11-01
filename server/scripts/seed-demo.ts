/**
 * Fills a throwaway SQLite database with demo posts that point at the nekotime GIFs
 * in `public/nekotime`. The Angular dev server serves those files, which makes the
 * grid, search and post detail page reviewable before real uploads exist.
 *
 *   cd server && npm run seed:demo
 *   DB_PATH=data/demo.db npm run dev
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createDb } from '../src/db.js';

const assetsDir = new URL('../../public/nekotime/', import.meta.url);
const dbPath = process.env.DB_PATH ?? 'data/demo.db';
const seedTime = Date.now();

const { sqlite } = createDb(dbPath);

const existing = sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get() as { count: number };
if (existing.count > 0) {
  console.log(`seed: ${dbPath} already has ${existing.count} posts, nothing to do`);
  process.exit(0);
}

const tagRows: Array<[name: string, category: string]> = [
  ['nekotime', 'general'],
  ['pixel_art', 'general'],
  ['chibi', 'general'],
  ['solo', 'general'],
  ['clock', 'general'],
  ['sign', 'general'],
  ['holding_sign', 'general'],
  ['nekotime_team', 'artist'],
  ['nekotime_chibi', 'character'],
  ['boorushiko', 'copyright'],
  ['demo', 'meta'],
];

const tagIds = new Map<string, number>();
for (const [name, category] of tagRows) {
  sqlite
    .prepare('INSERT OR IGNORE INTO tags (name, category, post_count) VALUES (?, ?, 0)')
    .run(name, category);
  const row = sqlite.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number };
  tagIds.set(name, row.id);
}

const insertPost = sqlite.prepare(
  `INSERT INTO posts (storage_kind, md5, sha256, mime, ext, width, height, bytes, rating, score,
    source_url, status, created_at, updated_at)
   VALUES ('hosted', ?, ?, 'image/gif', 'gif', 45, 100, ?, ?, ?, NULL, 'active', ?, ?)`,
);
const bumpTag = sqlite.prepare('UPDATE tags SET post_count = post_count + 1 WHERE id = ?');
const linkTag = sqlite.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)');
const insertSource = sqlite.prepare(
  `INSERT INTO post_sources (post_id, host, url, role, format, width, height, bytes, status,
    priority, fail_count, created_at)
   VALUES (?, 'demo', ?, 'serve', 'gif', 45, 100, ?, 'ok', 1, 0, ?)`,
);
const insertVariant = sqlite.prepare(
  `INSERT INTO post_variants (post_id, kind, url, width, height, bytes, format, quality)
   VALUES (?, 'thumb300', ?, 45, 100, ?, 'gif', 90)`,
);

const ratings = ['s', 's', 'q', 's', 'e', 's', 'q', 's', 's', 'q'] as const;
const scores = [42, 31, 18, 27, 63, 12, 9, 35, 21, 14];
const baseTags = ['nekotime', 'pixel_art', 'chibi', 'solo', 'clock', 'sign', 'holding_sign'];
const creditTags = ['nekotime_team', 'nekotime_chibi', 'boorushiko', 'demo'];

const seed = sqlite.transaction(() => {
  for (let index = 0; index < 10; index += 1) {
    const file = new URL(`${index}.gif`, assetsDir);
    const content = readFileSync(file);
    const size = statSync(file).size;
    const md5 = createHash('md5').update(content).digest('hex');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const url = `/nekotime/${index}.gif`;
    const createdAt = new Date(seedTime - index * 3_600_000).toISOString();

    const info = insertPost.run(
      md5,
      sha256,
      size,
      ratings[index] ?? 's',
      scores[index] ?? 0,
      createdAt,
      createdAt,
    );
    const postId = Number(info.lastInsertRowid);

    for (const name of [...baseTags, ...creditTags]) {
      const tagId = tagIds.get(name);
      if (tagId === undefined) continue;
      linkTag.run(postId, tagId);
      bumpTag.run(tagId);
    }

    insertSource.run(postId, url, size, createdAt);
    insertVariant.run(postId, url, size);
  }
});

seed();
sqlite.close();

console.log(`seed: wrote 10 demo posts into ${dbPath}`);
