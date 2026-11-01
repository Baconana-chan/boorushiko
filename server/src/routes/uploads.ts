import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser, type SessionUser } from '../auth.js';
import type { EngineContext } from '../context.js';
import { processJobs } from '../jobs.js';
import { DnpArtistError } from '../policy.js';
import { rateLimited, type RateLimiter } from '../rate-limit.js';
import { createPostFromStaged } from '../upload.js';
import { readUploadRequest, UploadRequestError } from '../upload-request.js';
import { canUpload, uploaderState, type UploaderState } from '../uploaders.js';

interface MyUploadRow {
  id: number;
  status: string;
  rating: string;
  mime: string;
  ext: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
  updatedAt: string;
  rejectionReason: string | null;
  moderationNote: string | null;
  policyFlags: string | null;
}

interface TagRow {
  postId: number;
  name: string;
  category: string;
}

function pageParams(query: Record<string, string | undefined>, defaultLimit = 20) {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), 100);
  return {
    page: Math.floor(page),
    limit: Math.floor(limit),
    offset: (Math.floor(page) - 1) * Math.floor(limit),
  };
}

function flagsOf(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function tagsFor(
  sqlite: EngineContext['sqlite'],
  ids: number[],
): Map<number, Array<{ name: string; category: string }>> {
  const result = new Map<number, Array<{ name: string; category: string }>>();
  if (ids.length === 0) return result;
  const rows = sqlite
    .prepare(
      `SELECT pt.post_id AS postId, t.name, t.category
       FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.post_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY t.category = 'general', t.name`,
    )
    .all(...ids) as TagRow[];
  for (const row of rows) {
    const list = result.get(row.postId) ?? [];
    list.push({ name: row.name, category: row.category });
    result.set(row.postId, list);
  }
  return result;
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

function requireUploader(
  ctx: EngineContext,
  request: FastifyRequest,
  reply: FastifyReply,
): SessionUser | null {
  const user = requireUser(ctx, request, reply);
  if (!user) return null;
  if (!canUpload(ctx.sqlite, user)) {
    reply.code(403).send({ error: 'approved uploader access required', code: 'uploader_required' });
    return null;
  }
  return user;
}

export function registerUploadRoutes(
  app: FastifyInstance,
  ctx: EngineContext,
  limiter: RateLimiter,
): void {
  app.get('/api/v1/me/uploader', async (request, reply) => {
    const user = requireUser(ctx, request, reply);
    if (!user) return;
    return uploaderState(ctx.sqlite, user);
  });

  app.post('/api/v1/me/uploader-request', async (request, reply) => {
    const user = requireUser(ctx, request, reply);
    if (!user) return;

    const limited = rateLimited(limiter, request, reply, 'uploaderRequest', `user:${user.id}`);
    if (limited) return limited;

    if (canUpload(ctx.sqlite, user)) {
      return reply
        .code(409)
        .send({ error: 'this account can already upload', code: 'already_uploader' });
    }

    const body =
      request.body !== null && typeof request.body === 'object'
        ? (request.body as Record<string, unknown>)
        : {};
    let message: string | null = null;
    if (body.message !== undefined && body.message !== null) {
      if (typeof body.message !== 'string') {
        return reply.code(400).send({ error: 'message must be text', code: 'invalid_message' });
      }
      message = body.message.trim();
      if (message.length > 1000) {
        return reply
          .code(400)
          .send({ error: 'message is longer than 1000 characters', code: 'invalid_message' });
      }
      if (!message) message = null;
    }

    const pending = ctx.sqlite
      .prepare("SELECT id FROM uploader_requests WHERE user_id = ? AND status = 'pending'")
      .get(user.id);
    if (pending) {
      return reply
        .code(409)
        .send({ error: 'an application is already waiting for review', code: 'request_pending' });
    }

    const now = new Date().toISOString();
    try {
      ctx.sqlite
        .prepare(
          `INSERT INTO uploader_requests (user_id, message, status, created_at)
           VALUES (?, ?, 'pending', ?)`,
        )
        .run(user.id, message, now);
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return reply
          .code(409)
          .send({ error: 'an application is already waiting for review', code: 'request_pending' });
      }
      throw error;
    }

    const state: UploaderState = uploaderState(ctx.sqlite, user);
    return reply.code(201).send(state);
  });

  app.get('/api/v1/me/uploads', async (request, reply) => {
    const user = requireUploader(ctx, request, reply);
    if (!user) return;

    const query = request.query as Record<string, string | undefined>;
    const { page, limit, offset } = pageParams(query);
    const total = ctx.sqlite
      .prepare('SELECT COUNT(*) AS count FROM posts WHERE uploaded_by = ?')
      .get(user.id) as { count: number };

    const rows = ctx.sqlite
      .prepare(
        `SELECT id, status, rating, mime, ext, width, height, bytes,
                created_at AS createdAt, updated_at AS updatedAt,
                rejection_reason AS rejectionReason, moderation_note AS moderationNote,
                policy_flags AS policyFlags
         FROM posts
         WHERE uploaded_by = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(user.id, limit + 1, offset) as MyUploadRow[];
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    const tags = tagsFor(
      ctx.sqlite,
      visible.map((row) => row.id),
    );

    return {
      page,
      limit,
      total: total.count,
      hasMore,
      uploads: visible.map((row) => ({
        ...row,
        policyFlags: flagsOf(row.policyFlags),
        tags: tags.get(row.id) ?? [],
        // Pending and deleted posts have no publicly served thumbnail.
        thumbUrl: row.status === 'active' || row.status === 'hidden' ? `/t/${row.id}?v=2` : null,
      })),
    };
  });

  app.post('/api/v1/uploads', async (request, reply) => {
    const user = requireUploader(ctx, request, reply);
    if (!user) return;

    const limited = rateLimited(limiter, request, reply, 'upload', `user:${user.id}`);
    if (limited) return limited;

    let parsed;
    try {
      parsed = await readUploadRequest(request, {
        dir: ctx.config.stagingDir,
        maxBytes: ctx.config.maxUploadBytes,
      });
    } catch (error) {
      if (error instanceof UploadRequestError) {
        return reply.code(error.status).send({ error: error.message, code: error.code });
      }
      throw error;
    }

    try {
      const result = await createPostFromStaged(ctx, parsed.staged, {
        tags: parsed.fields.tags,
        rating: parsed.fields.rating,
        sourceUrl: parsed.fields.sourceUrl,
        filename: parsed.filename,
        uploadedBy: user.id,
      });
      // Kick the queue once so a single upload usually becomes visible immediately.
      void processJobs(ctx).catch(() => undefined);
      return reply.code(result.duplicate ? 200 : 201).send({
        postId: result.postId,
        duplicate: result.duplicate,
        status: result.status,
        jobs: result.jobs,
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      const status = name === 'DnpArtistError' ? 403 : name === 'UnsupportedMediaError' ? 415 : 400;
      return reply.code(status).send({
        error: error instanceof Error ? error.message : 'cannot create post',
        ...(error instanceof DnpArtistError
          ? { code: 'dnp_artist', artist: error.artist }
          : name === 'UnsupportedMediaError'
            ? { code: 'unsupported_media' }
            : {}),
      });
    }
  });
}
