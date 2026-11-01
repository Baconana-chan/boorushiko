import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser, type SessionUser } from '../auth.js';
import type { EngineContext } from '../context.js';
import { postLinks } from '../links.js';
import { rateLimited, type RateLimiter } from '../rate-limit.js';
import { postsByIds } from '../search.js';

const POOL_CATEGORIES = new Set(['series', 'collection', 'event', 'other']);
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;

interface PoolRow {
  id: number;
  title: string;
  description: string | null;
  category: string;
  isPublic: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  postCount: number;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function isStaff(user: SessionUser): boolean {
  return user.role === 'moderator' || user.role === 'admin';
}

function requireUser(
  ctx: EngineContext,
  request: FastifyRequest,
  reply: FastifyReply,
): SessionUser | null {
  const user = currentUser(ctx.sqlite, request);
  if (!user) {
    reply.code(401).send({ error: 'sign in first', code: 'auth_required' });
    return null;
  }
  return user;
}

function requireStaff(
  ctx: EngineContext,
  request: FastifyRequest,
  reply: FastifyReply,
): SessionUser | null {
  const user = requireUser(ctx, request, reply);
  if (!user) return null;
  if (!isStaff(user)) {
    reply.code(403).send({ error: 'moderator access required', code: 'staff_required' });
    return null;
  }
  return user;
}

function poolDto(row: PoolRow, baseUrl: string) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    isPublic: row.isPublic === 1,
    postCount: row.postCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    url: `${baseUrl}/pools/${row.id}`,
  };
}

const POOL_SELECT = `SELECT p.id, p.title, p.description, p.category, p.is_public AS isPublic,
       p.created_at AS createdAt, p.updated_at AS updatedAt, u.username AS createdBy,
       (SELECT COUNT(*) FROM pool_posts pp JOIN posts k ON k.id = pp.post_id
        WHERE pp.pool_id = p.id AND k.status = 'active') AS postCount
  FROM pools p LEFT JOIN users u ON u.id = p.created_by`;

function getPool(ctx: EngineContext, id: number): PoolRow | undefined {
  return ctx.sqlite.prepare(`${POOL_SELECT} WHERE p.id = ?`).get(id) as PoolRow | undefined;
}

/** Walking up from the proposed parent must never reach the child itself. */
function wouldCycle(ctx: EngineContext, postId: number, parentId: number): boolean {
  let cursor: number | null = parentId;
  for (let step = 0; step < 100 && cursor; step += 1) {
    if (cursor === postId) return true;
    const row = ctx.sqlite.prepare('SELECT parent_id AS parentId FROM posts WHERE id = ?').get(
      cursor,
    ) as { parentId: number | null } | undefined;
    cursor = row?.parentId ?? null;
  }
  return false;
}

function favoriteState(ctx: EngineContext, postId: number, userId: number) {
  const count = ctx.sqlite
    .prepare('SELECT COUNT(*) AS count FROM favorites WHERE post_id = ?')
    .get(postId) as { count: number };
  const mine = ctx.sqlite
    .prepare('SELECT 1 AS yes FROM favorites WHERE post_id = ? AND user_id = ?')
    .get(postId, userId);
  return { favorited: Boolean(mine), favoriteCount: count.count };
}

export function registerCollectionRoutes(
  app: FastifyInstance,
  ctx: EngineContext,
  limiter: RateLimiter,
): void {
  const baseUrl = () => ctx.config.publicBaseUrl.replace(/\/+$/, '');

  // ---------------------------------------------------------------- favorites

  app.post('/api/v1/posts/:id/favorite', async (request, reply) => {
    const user = requireUser(ctx, request, reply);
    if (!user) return;
    const postId = positiveInt((request.params as { id?: string }).id);
    if (!postId) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    const post = ctx.sqlite
      .prepare("SELECT id FROM posts WHERE id = ? AND status <> 'deleted'")
      .get(postId);
    if (!post) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    ctx.sqlite
      .prepare('INSERT OR IGNORE INTO favorites (user_id, post_id, created_at) VALUES (?, ?, ?)')
      .run(user.id, postId, new Date().toISOString());
    return favoriteState(ctx, postId, user.id);
  });

  app.delete('/api/v1/posts/:id/favorite', async (request, reply) => {
    const user = requireUser(ctx, request, reply);
    if (!user) return;
    const postId = positiveInt((request.params as { id?: string }).id);
    if (!postId) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    ctx.sqlite.prepare('DELETE FROM favorites WHERE user_id = ? AND post_id = ?').run(user.id, postId);
    return favoriteState(ctx, postId, user.id);
  });

  app.get('/api/v1/me/favorites', async (request, reply) => {
    const user = requireUser(ctx, request, reply);
    if (!user) return;
    const limited = rateLimited(limiter, request, reply, 'apiPosts', `user:${user.id}`);
    if (limited) return limited;

    const query = request.query as Record<string, string | undefined>;
    const limit = boundedInt(query.limit, 24, 1, 100);
    const page = boundedInt(query.page, 1, 1, 100_000);
    const offset = (page - 1) * limit;

    const rows = ctx.sqlite
      .prepare(
        `SELECT f.post_id AS postId, f.created_at AS createdAt
         FROM favorites f JOIN posts p ON p.id = f.post_id
         WHERE f.user_id = ? AND p.status = 'active'
         ORDER BY f.created_at DESC, f.post_id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(user.id, limit + 1, offset) as Array<{ postId: number; createdAt: string }>;
    const total = ctx.sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM favorites f JOIN posts p ON p.id = f.post_id
         WHERE f.user_id = ? AND p.status = 'active'`,
      )
      .get(user.id) as { count: number };

    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const favorites = new Map(pageRows.map((row) => [row.postId, row.createdAt]));
    const posts = postsByIds(
      ctx.sqlite,
      pageRows.map((row) => row.postId),
    ).map((post) => ({
      ...post,
      ...postLinks(post.id, baseUrl()),
      favoritedAt: favorites.get(post.id) ?? null,
    }));

    return { page, limit, total: total.count, hasMore, posts };
  });

  // -------------------------------------------------------------------- pools

  app.get('/api/v1/pools', async (request, reply) => {
    const limited = rateLimited(limiter, request, reply, 'apiPosts');
    if (limited) return limited;

    const query = request.query as Record<string, string | undefined>;
    const limit = boundedInt(query.limit, 20, 1, 50);
    const page = boundedInt(query.page, 1, 1, 10_000);
    const offset = (page - 1) * limit;

    const rows = ctx.sqlite
      .prepare(
        `${POOL_SELECT} WHERE p.is_public = 1
         ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit + 1, offset) as PoolRow[];
    const total = ctx.sqlite
      .prepare('SELECT COUNT(*) AS count FROM pools WHERE is_public = 1')
      .get() as { count: number };

    return {
      page,
      limit,
      total: total.count,
      hasMore: rows.length > limit,
      pools: rows.slice(0, limit).map((row) => poolDto(row, baseUrl())),
    };
  });

  app.get('/api/v1/pools/:id', async (request, reply) => {
    const id = positiveInt((request.params as { id?: string }).id);
    if (!id) return reply.code(404).send({ error: 'pool not found', code: 'pool_not_found' });
    const pool = getPool(ctx, id);
    if (!pool) return reply.code(404).send({ error: 'pool not found', code: 'pool_not_found' });
    // A private pool only exists for staff; everyone else gets the same 404 as
    // for a missing id so its title cannot be probed.
    const viewer = currentUser(ctx.sqlite, request);
    if (pool.isPublic !== 1 && (!viewer || !isStaff(viewer))) {
      return reply.code(404).send({ error: 'pool not found', code: 'pool_not_found' });
    }

    const query = request.query as Record<string, string | undefined>;
    const limit = boundedInt(query.limit, 50, 1, 200);
    const page = boundedInt(query.page, 1, 1, 10_000);
    const offset = (page - 1) * limit;

    const rows = ctx.sqlite
      .prepare(
        `SELECT pp.post_id AS postId FROM pool_posts pp JOIN posts p ON p.id = pp.post_id
         WHERE pp.pool_id = ? AND p.status = 'active'
         ORDER BY pp.position ASC, pp.post_id ASC LIMIT ? OFFSET ?`,
      )
      .all(id, limit + 1, offset) as Array<{ postId: number }>;
    const hasMore = rows.length > limit;
    const posts = postsByIds(
      ctx.sqlite,
      rows.slice(0, limit).map((row) => row.postId),
    ).map((post) => ({ ...post, ...postLinks(post.id, baseUrl()) }));

    return {
      pool: poolDto(pool, baseUrl()),
      page,
      limit,
      hasMore,
      posts,
    };
  });

  app.post('/api/v1/pools', async (request, reply) => {
    const user = requireStaff(ctx, request, reply);
    if (!user) return;

    const body = (request.body ?? {}) as Record<string, unknown>;
    const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
    if (!title || title.length > TITLE_MAX) {
      return reply.code(400).send({ error: `title must be 1-${TITLE_MAX} characters`, code: 'invalid_title' });
    }
    const description =
      typeof body['description'] === 'string' ? body['description'].trim().slice(0, DESCRIPTION_MAX) || null : null;
    const category =
      typeof body['category'] === 'string' && POOL_CATEGORIES.has(body['category'])
        ? body['category']
        : 'series';
    const isPublic = body['isPublic'] === false ? 0 : 1;
    const now = new Date().toISOString();

    const info = ctx.sqlite
      .prepare(
        `INSERT INTO pools (title, description, category, is_public, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(title, description, category, isPublic, user.id, now, now);
    const pool = getPool(ctx, Number(info.lastInsertRowid));
    return reply.code(201).send({ pool: pool ? poolDto(pool, baseUrl()) : null });
  });

  app.patch('/api/v1/pools/:id', async (request, reply) => {
    const user = requireStaff(ctx, request, reply);
    if (!user) return;
    const id = positiveInt((request.params as { id?: string }).id);
    if (!id) return reply.code(404).send({ error: 'pool not found', code: 'pool_not_found' });
    const pool = getPool(ctx, id);
    if (!pool) return reply.code(404).send({ error: 'pool not found', code: 'pool_not_found' });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const title =
      typeof body['title'] === 'string' && body['title'].trim() ? body['title'].trim() : pool.title;
    if (title.length > TITLE_MAX) {
      return reply.code(400).send({ error: `title must be 1-${TITLE_MAX} characters`, code: 'invalid_title' });
    }
    const description =
      typeof body['description'] === 'string'
        ? body['description'].trim().slice(0, DESCRIPTION_MAX) || null
        : pool.description;
    const category =
      typeof body['category'] === 'string' && POOL_CATEGORIES.has(body['category'])
        ? body['category']
        : pool.category;
    const isPublic =
      typeof body['isPublic'] === 'boolean' ? (body['isPublic'] ? 1 : 0) : pool.isPublic;

    ctx.sqlite
      .prepare(
        'UPDATE pools SET title = ?, description = ?, category = ?, is_public = ?, updated_at = ? WHERE id = ?',
      )
      .run(title, description, category, isPublic, new Date().toISOString(), id);
    const updated = getPool(ctx, id);
    return { pool: updated ? poolDto(updated, baseUrl()) : null };
  });

  app.delete('/api/v1/pools/:id', async (request, reply) => {
    const user = requireStaff(ctx, request, reply);
    if (!user) return;
    const id = positiveInt((request.params as { id?: string }).id);
    if (!id) return reply.code(404).send({ error: 'pool not found', code: 'pool_not_found' });
    const info = ctx.sqlite.prepare('DELETE FROM pools WHERE id = ?').run(id);
    if (info.changes === 0) {
      return reply.code(404).send({ error: 'pool not found', code: 'pool_not_found' });
    }
    return reply.code(204).send();
  });

  app.post('/api/v1/pools/:id/posts', async (request, reply) => {
    const user = requireStaff(ctx, request, reply);
    if (!user) return;
    const poolId = positiveInt((request.params as { id?: string }).id);
    if (!poolId || !getPool(ctx, poolId)) {
      return reply.code(404).send({ error: 'pool not found', code: 'pool_not_found' });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const postId = positiveInt(body['postId']);
    if (!postId) return reply.code(400).send({ error: 'postId is required', code: 'invalid_post' });
    const post = ctx.sqlite
      .prepare("SELECT id FROM posts WHERE id = ? AND status <> 'deleted'")
      .get(postId);
    if (!post) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    const next = ctx.sqlite
      .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM pool_posts WHERE pool_id = ?')
      .get(poolId) as { next: number };
    const requestedPosition = Number(body['position']);
    const position =
      Number.isFinite(requestedPosition) && requestedPosition >= 0
        ? Math.floor(requestedPosition)
        : next.next;

    ctx.sqlite
      .prepare(
        `INSERT INTO pool_posts (pool_id, post_id, position, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (pool_id, post_id) DO UPDATE SET position = excluded.position`,
      )
      .run(poolId, postId, position, new Date().toISOString());
    ctx.sqlite
      .prepare('UPDATE pools SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), poolId);

    return { postId, position };
  });

  app.delete('/api/v1/pools/:id/posts/:postId', async (request, reply) => {
    const user = requireStaff(ctx, request, reply);
    if (!user) return;
    const poolId = positiveInt((request.params as { id?: string }).id);
    const postId = positiveInt((request.params as { postId?: string }).postId);
    if (!poolId || !postId) {
      return reply.code(404).send({ error: 'pool not found', code: 'pool_not_found' });
    }
    ctx.sqlite
      .prepare('DELETE FROM pool_posts WHERE pool_id = ? AND post_id = ?')
      .run(poolId, postId);
    ctx.sqlite
      .prepare('UPDATE pools SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), poolId);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------- parent/child

  app.post('/api/v1/posts/:id/parent', async (request, reply) => {
    const user = requireStaff(ctx, request, reply);
    if (!user) return;
    const postId = positiveInt((request.params as { id?: string }).id);
    if (!postId) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });
    const post = ctx.sqlite.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
    if (!post) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    const body = (request.body ?? {}) as Record<string, unknown>;
    const raw = body['parentId'];
    let parentId: number | null = null;
    if (raw !== null && raw !== undefined) {
      const parsed = positiveInt(raw);
      if (!parsed) {
        return reply.code(400).send({ error: 'parentId must be a post id or null', code: 'invalid_parent' });
      }
      const parent = ctx.sqlite
        .prepare("SELECT id FROM posts WHERE id = ? AND status <> 'deleted'")
        .get(parsed);
      if (!parent) {
        return reply.code(404).send({ error: 'parent post not found', code: 'parent_not_found' });
      }
      parentId = parsed;
    }

    if (parentId !== null && wouldCycle(ctx, postId, parentId)) {
      return reply
        .code(409)
        .send({ error: 'that parent would create a cycle', code: 'parent_cycle' });
    }

    ctx.sqlite
      .prepare('UPDATE posts SET parent_id = ?, updated_at = ? WHERE id = ?')
      .run(parentId, new Date().toISOString(), postId);
    return { postId, parentId };
  });
}
