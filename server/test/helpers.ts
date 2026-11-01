import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import type { EngineContext } from '../src/context.js';
import { createDb } from '../src/db.js';
import { nullLogger } from '../src/logger.js';
import type { MirrorHost } from '../src/mirrors/types.js';

export interface TestContext {
  ctx: EngineContext;
  uploaded: Array<{ filename: string; mime: string }>;
  root: string;
}

export function createTestContext(overrides: Partial<Config> = {}): TestContext {
  const root = mkdtempSync(join(tmpdir(), 'boorushiko-test-'));
  const config = loadConfig({
    dbPath: ':memory:',
    stagingDir: join(root, 'staging'),
    mirrors: [],
    maxUploadBytes: 8 * 1024 * 1024,
    minMirrors: 1,
    stagingTtlMinutes: 60,
    ...overrides,
  });
  const { sqlite, db } = createDb(config.dbPath);

  const uploaded: Array<{ filename: string; mime: string }> = [];
  const fake: MirrorHost = {
    name: 'fake',
    maxBytes: 64 * 1024 * 1024,
    accepts: () => true,
    async upload(input) {
      uploaded.push({ filename: input.filename, mime: input.mime });
      return { url: `https://fake.local/${encodeURIComponent(input.filename)}` };
    },
  };

  return {
    ctx: { sqlite, db, config, mirrors: new Map([['fake', fake]]), log: nullLogger() },
    uploaded,
    root,
  };
}

export interface SeedOptions {
  md5: string;
  tags?: string[];
  /** Optional tag categories (`artist`, `character`, ...); general by default. */
  categories?: Record<string, string>;
  rating?: 's' | 'q' | 'e';
  score?: number;
  status?: string;
  createdAt?: string;
  uploadedBy?: number;
  policyFlags?: string[];
}

export function seedPost(ctx: EngineContext, options: SeedOptions): number {
  const now = options.createdAt ?? '2026-01-01T00:00:00.000Z';
  const inserted = ctx.sqlite
    .prepare(
      `INSERT INTO posts
        (storage_kind, md5, sha256, mime, ext, width, height, bytes, rating, score, status, created_at, updated_at)
       VALUES ('hosted', ?, ?, 'image/png', 'png', 100, 100, 1000, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.md5,
      options.md5,
      options.rating ?? 's',
      options.score ?? 0,
      options.status ?? 'active',
      now,
      now,
    );
  const postId = Number(inserted.lastInsertRowid);
  if (options.uploadedBy !== undefined || options.policyFlags !== undefined) {
    ctx.sqlite
      .prepare('UPDATE posts SET uploaded_by = ?, policy_flags = ? WHERE id = ?')
      .run(options.uploadedBy ?? null, JSON.stringify(options.policyFlags ?? []), postId);
  }

  const upsert = ctx.sqlite.prepare(
    `INSERT INTO tags (name, category, post_count) VALUES (?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET post_count = post_count + 1
     RETURNING id`,
  );
  const link = ctx.sqlite.prepare(
    'INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)',
  );
  for (const tag of options.tags ?? []) {
    const row = upsert.get(tag, options.categories?.[tag] ?? 'general') as { id: number };
    link.run(postId, row.id);
  }

  return postId;
}
