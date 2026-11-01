import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser, type SessionUser } from '../auth.js';
import type { EngineContext } from '../context.js';
import { enqueueJob, processSourceJobs } from '../jobs.js';
import { isModerationReason, MODERATION_REASONS, type ModerationReason } from '../policy.js';
import { rateLimited, type RateLimiter } from '../rate-limit.js';
import {
  listSourceSchedules,
  updateSourceSchedule,
  type SourceSchedulePatch,
} from '../schedules.js';
import { SOURCE_NAMES, type SourceName } from '../sources/index.js';

type PostStatus = 'pending' | 'active' | 'hidden' | 'deleted';
type ReportStatus = 'open' | 'resolved' | 'dismissed';

const POST_STATUSES = new Set<PostStatus>(['pending', 'active', 'hidden', 'deleted']);
const REPORT_STATUSES = new Set<ReportStatus>(['open', 'resolved', 'dismissed']);

const REASON_LABELS: Record<ModerationReason, string> = {
  ai: 'AI-generated content',
  '3d': '3D render',
  not_2d: 'Not hand-drawn 2D',
  duplicate: 'Duplicate post',
  low_quality: 'Low quality',
  banned_artist: 'Artist is on the DNP list',
  copyright: 'Copyright or takedown request',
  metadata: 'Suspicious metadata',
  other: 'Other policy issue',
};

const ADMIN_POST_SELECT = `SELECT
    p.id, p.storage_kind AS storageKind, p.mime, p.ext, p.width, p.height, p.bytes,
    p.rating, p.score, p.source_url AS sourceUrl, p.status, p.created_at AS createdAt,
    p.updated_at AS updatedAt, p.uploaded_by AS uploadedBy, p.moderated_by AS moderatedBy,
    p.moderated_at AS moderatedAt, p.rejection_reason AS rejectionReason,
    p.moderation_note AS moderationNote, p.policy_flags AS policyFlags,
    u.username AS uploadedByName,
    (SELECT COUNT(*) FROM post_sources s WHERE s.post_id = p.id) AS sourceCount,
    (SELECT COUNT(*) FROM post_origins o WHERE o.post_id = p.id) AS originCount,
    (SELECT COUNT(*) FROM reports r WHERE r.post_id = p.id AND r.status = 'open') AS reportCount
  FROM posts p
  LEFT JOIN users u ON u.id = p.uploaded_by`;

const SOURCE_RUN_SELECT = `SELECT
    r.id, r.source, r.tags, r.limit_count AS limitCount, r.page, r.page_size AS pageSize,
    r.delay_ms AS delayMs, r.status, r.imported, r.duplicates, r.failed, r.seen, r.pages,
    r.auto, r.mode, r.since_id AS sinceId, r.cursor,
    r.cancel_requested AS cancelRequested, r.error, u.username AS createdBy,
    r.created_at AS createdAt, r.started_at AS startedAt, r.finished_at AS finishedAt
  FROM source_runs r
  LEFT JOIN users u ON u.id = r.created_by`;

interface AdminPostRow {
  id: number;
  storageKind: string;
  mime: string;
  ext: string;
  width: number;
  height: number;
  bytes: number;
  rating: string;
  score: number;
  sourceUrl: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  uploadedBy: number | null;
  moderatedBy: number | null;
  moderatedAt: string | null;
  rejectionReason: string | null;
  moderationNote: string | null;
  policyFlags: string | null;
  uploadedByName: string | null;
  sourceCount: number;
  originCount: number;
  reportCount: number;
}

interface TagRow {
  postId: number;
  name: string;
  category: string;
}

interface ReportRow {
  id: number;
  postId: number;
  reason: string;
  body: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  reporter: string | null;
  resolvedBy: string | null;
  postStatus: string;
  postRating: string;
}

interface DnpRow {
  id: number;
  name: string;
  sourcePattern: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

interface AuditRow {
  id: number;
  action: string;
  targetType: string;
  targetId: number | null;
  reason: string | null;
  details: string | null;
  createdAt: string;
  actor: string | null;
}

interface UploaderRequestAdminRow {
  id: number;
  userId: number;
  username: string;
  message: string | null;
  status: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  reviewer: string | null;
}

interface UploaderEntryRow {
  userId: number;
  username: string;
  approvedAt: string;
  approvedBy: string | null;
  note: string | null;
  postCount: number;
}

interface SourceRunRow {
  id: number;
  source: string;
  tags: string | null;
  limitCount: number;
  page: number;
  pageSize: number;
  delayMs: number;
  status: string;
  imported: number;
  duplicates: number;
  failed: number;
  seen: number;
  pages: number;
  auto: number;
  mode: string;
  sinceId: string | null;
  cursor: string | null;
  cancelRequested: number;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface SourceRunLogRow {
  id: number;
  level: string;
  message: string;
  createdAt: string;
}

function uploaderRequestSelect(where: string): string {
  return `SELECT r.id, r.user_id AS userId, u.username, r.message, r.status,
                 r.created_at AS createdAt, r.reviewed_at AS reviewedAt,
                 r.review_note AS reviewNote, reviewer.username AS reviewer
          FROM uploader_requests r
          JOIN users u ON u.id = r.user_id
          LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
          ${where}`;
}

function bodyOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error('expected text');
  const text = value.trim();
  if (text.length > max) throw new Error(`text is longer than ${max} characters`);
  return text || null;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function sourceRunDto(row: SourceRunRow) {
  return { ...row, auto: row.auto === 1, cancelRequested: row.cancelRequested === 1 };
}

function getSourceRun(ctx: EngineContext, id: number) {
  const row = ctx.sqlite.prepare(`${SOURCE_RUN_SELECT} WHERE r.id = ?`).get(id) as
    SourceRunRow | undefined;
  return row ? sourceRunDto(row) : null;
}

function writeSourceRunLog(
  ctx: EngineContext,
  runId: number,
  level: 'info' | 'warn' | 'error',
  message: string,
): void {
  ctx.sqlite
    .prepare('INSERT INTO source_run_logs (run_id, level, message, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, level, message.slice(0, 2000), new Date().toISOString());
}

function moderatorsOnly(
  ctx: EngineContext,
  request: FastifyRequest,
  reply: FastifyReply,
): SessionUser | null {
  const user = currentUser(ctx.sqlite, request);
  if (!user) {
    reply.code(401).send({ error: 'sign in first', code: 'auth_required' });
    return null;
  }
  if (user.role === 'user') {
    reply.code(403).send({ error: 'moderator access required', code: 'forbidden' });
    return null;
  }
  return user;
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

function adminPost(
  sqlite: EngineContext['sqlite'],
  row: AdminPostRow,
  tags: Array<{ name: string; category: string }> = [],
) {
  return {
    id: row.id,
    storageKind: row.storageKind,
    mime: row.mime,
    ext: row.ext,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    rating: row.rating,
    score: row.score,
    sourceUrl: row.sourceUrl,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    uploadedBy: row.uploadedByName,
    moderatedAt: row.moderatedAt,
    rejectionReason: row.rejectionReason,
    moderationNote: row.moderationNote,
    policyFlags: flagsOf(row.policyFlags),
    sourceCount: row.sourceCount,
    originCount: row.originCount,
    reportCount: row.reportCount,
    tags,
    thumbUrl: `/t/${row.id}?v=2`,
  };
}

function getAdminPost(ctx: EngineContext, id: number) {
  const row = ctx.sqlite.prepare(`${ADMIN_POST_SELECT} WHERE p.id = ?`).get(id) as
    AdminPostRow | undefined;
  if (!row) return null;
  const tags = tagsFor(ctx.sqlite, [id]).get(id) ?? [];
  return adminPost(ctx.sqlite, row, tags);
}

function writeAudit(
  ctx: EngineContext,
  actorId: number,
  action: string,
  targetType: string,
  targetId: number | null,
  reason: string | null = null,
  details: string | null = null,
): void {
  ctx.sqlite
    .prepare(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, reason, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(actorId, action, targetType, targetId, reason, details, new Date().toISOString());
}

function notify(
  ctx: EngineContext,
  userId: number | null,
  kind: string,
  postId: number | null,
  body: string,
): void {
  if (!userId) return;
  ctx.sqlite
    .prepare(
      `INSERT INTO notifications (user_id, kind, post_id, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, kind, postId, body, new Date().toISOString());
}

function notifyPostAuthor(
  ctx: EngineContext,
  post: { id: number; uploadedBy: number | null },
  kind: string,
  body: string,
): void {
  notify(ctx, post.uploadedBy, kind, post.id, body);
}

function reportSelect(where: string): string {
  return `SELECT
      r.id, r.post_id AS postId, r.reason, r.body, r.status, r.created_at AS createdAt,
      r.resolved_at AS resolvedAt, r.resolution_note AS resolutionNote,
      reporter.username AS reporter, resolver.username AS resolvedBy,
      p.status AS postStatus, p.rating AS postRating
    FROM reports r
    JOIN posts p ON p.id = r.post_id
    LEFT JOIN users reporter ON reporter.id = r.reporter_id
    LEFT JOIN users resolver ON resolver.id = r.resolved_by
    ${where}`;
}

function reportDto(row: ReportRow) {
  return {
    id: row.id,
    postId: row.postId,
    reason: row.reason,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    reporter: row.reporter,
    resolvedBy: row.resolvedBy,
    post: {
      id: row.postId,
      status: row.postStatus,
      rating: row.postRating,
      thumbUrl: `/t/${row.postId}?v=2`,
    },
  };
}

function getReport(ctx: EngineContext, id: number) {
  const row = ctx.sqlite.prepare(reportSelect('WHERE r.id = ?')).get(id) as ReportRow | undefined;
  return row ? reportDto(row) : null;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  ctx: EngineContext,
  limiter: RateLimiter,
): void {
  app.get('/api/v1/admin/overview', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const postCounts = ctx.sqlite
      .prepare('SELECT status, COUNT(*) AS count FROM posts GROUP BY status')
      .all() as Array<{ status: string; count: number }>;
    const counts = Object.fromEntries(postCounts.map((row) => [row.status, row.count]));
    const openReports = ctx.sqlite
      .prepare("SELECT COUNT(*) AS count FROM reports WHERE status = 'open'")
      .get() as { count: number };
    const dnp = ctx.sqlite.prepare('SELECT COUNT(*) AS count FROM dnp_artists').get() as {
      count: number;
    };
    const flagged = ctx.sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM posts
         WHERE status = 'pending' AND policy_flags <> '[]'`,
      )
      .get() as { count: number };
    const uploaderRequests = ctx.sqlite
      .prepare("SELECT COUNT(*) AS count FROM uploader_requests WHERE status = 'pending'")
      .get() as { count: number };

    return {
      posts: {
        pending: counts['pending'] ?? 0,
        active: counts['active'] ?? 0,
        hidden: counts['hidden'] ?? 0,
        deleted: counts['deleted'] ?? 0,
      },
      openReports: openReports.count,
      dnp: dnp.count,
      flaggedPending: flagged.count,
      pendingUploaderRequests: uploaderRequests.count,
    };
  });

  app.get('/api/v1/admin/queue', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const query = request.query as Record<string, string | undefined>;
    const requestedStatus = (query.status ?? 'pending') as PostStatus;
    if (!POST_STATUSES.has(requestedStatus)) {
      return reply.code(400).send({ error: 'unknown status', code: 'invalid_status' });
    }
    const { page, limit, offset } = pageParams(query);

    const total = ctx.sqlite
      .prepare('SELECT COUNT(*) AS count FROM posts WHERE status = ?')
      .get(requestedStatus) as { count: number };
    const rows = ctx.sqlite
      .prepare(
        `${ADMIN_POST_SELECT} WHERE p.status = ? ORDER BY p.created_at ASC, p.id ASC LIMIT ? OFFSET ?`,
      )
      .all(requestedStatus, limit + 1, offset) as AdminPostRow[];
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    const tags = tagsFor(
      ctx.sqlite,
      visible.map((row) => row.id),
    );

    return {
      page,
      limit,
      hasMore,
      total: total.count,
      posts: visible.map((row) => adminPost(ctx.sqlite, row, tags.get(row.id) ?? [])),
    };
  });

  app.patch('/api/v1/admin/posts/:id', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const id = positiveInt((request.params as { id?: string }).id);
    if (!id) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    const body = bodyOf(request.body);
    const nextStatus = body.status === undefined ? undefined : String(body.status);
    if (nextStatus !== undefined && !POST_STATUSES.has(nextStatus as PostStatus)) {
      return reply.code(400).send({ error: 'unknown status', code: 'invalid_status' });
    }
    if (nextStatus === 'pending') {
      return reply
        .code(400)
        .send({ error: 'cannot return a post to pending', code: 'invalid_status' });
    }

    const nextRating = body.rating === undefined ? undefined : String(body.rating);
    if (nextRating !== undefined && !['s', 'q', 'e'].includes(nextRating)) {
      return reply.code(400).send({ error: 'rating must be s, q or e', code: 'invalid_rating' });
    }

    let reason: string | null = null;
    if (body.reason !== undefined && body.reason !== null) {
      if (!isModerationReason(body.reason)) {
        return reply.code(400).send({ error: 'unknown moderation reason', code: 'invalid_reason' });
      }
      reason = body.reason;
    }
    if (nextStatus === 'hidden' && !reason) {
      return reply
        .code(400)
        .send({ error: 'a rejection reason is required', code: 'reason_required' });
    }

    let note: string | null = null;
    try {
      note = optionalText(body.note, 1000);
    } catch {
      return reply.code(400).send({ error: 'note is too long', code: 'invalid_note' });
    }

    const current = ctx.sqlite
      .prepare('SELECT id, status, rating, uploaded_by AS uploadedBy FROM posts WHERE id = ?')
      .get(id) as
      { id: number; status: string; rating: string; uploadedBy: number | null } | undefined;
    if (!current) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });
    if (!nextStatus && !nextRating) {
      return reply.code(400).send({ error: 'nothing to update', code: 'no_changes' });
    }

    const now = new Date().toISOString();
    const run = ctx.sqlite.transaction(() => {
      if (nextStatus && nextStatus !== current.status) {
        ctx.sqlite
          .prepare(
            `UPDATE posts
             SET status = ?, moderated_by = ?, moderated_at = ?, rejection_reason = ?,
                 moderation_note = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            nextStatus,
            actor.id,
            now,
            nextStatus === 'hidden' || nextStatus === 'deleted' ? reason : null,
            nextStatus === 'hidden' || nextStatus === 'deleted' ? note : null,
            now,
            id,
          );

        const action =
          nextStatus === 'active'
            ? 'post.approve'
            : nextStatus === 'hidden'
              ? 'post.reject'
              : 'post.delete';
        writeAudit(ctx, actor.id, action, 'post', id, reason, note);
      }

      if (nextRating && nextRating !== current.rating) {
        ctx.sqlite
          .prepare('UPDATE posts SET rating = ?, updated_at = ? WHERE id = ?')
          .run(nextRating, now, id);
        writeAudit(
          ctx,
          actor.id,
          'post.rating',
          'post',
          id,
          null,
          `${current.rating} -> ${nextRating}`,
        );
      }

      if (nextStatus === 'hidden') {
        notifyPostAuthor(
          ctx,
          current,
          'post_hidden',
          `Your post #${id} was hidden: ${reason ? REASON_LABELS[reason as ModerationReason] : 'policy review'}.`,
        );
      } else if (nextStatus === 'active' && current.status === 'hidden') {
        notifyPostAuthor(ctx, current, 'post_restored', `Your post #${id} was approved again.`);
      }
    });
    run();

    return { post: getAdminPost(ctx, id) };
  });

  app.get('/api/v1/admin/reports', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const query = request.query as Record<string, string | undefined>;
    const requestedStatus = query.status ?? 'open';
    if (requestedStatus !== 'all' && !REPORT_STATUSES.has(requestedStatus as ReportStatus)) {
      return reply.code(400).send({ error: 'unknown report status', code: 'invalid_status' });
    }
    const where = requestedStatus === 'all' ? '' : 'WHERE r.status = ?';
    const params = requestedStatus === 'all' ? [] : [requestedStatus];
    const total = ctx.sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM reports r ${requestedStatus === 'all' ? '' : 'WHERE r.status = ?'}`,
      )
      .get(...params) as { count: number };
    const rows = ctx.sqlite
      .prepare(`${reportSelect(where)} ORDER BY r.created_at ASC, r.id ASC LIMIT 100`)
      .all(...params) as ReportRow[];

    return { reports: rows.map(reportDto), total: total.count };
  });

  app.patch('/api/v1/admin/reports/:id', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const id = positiveInt((request.params as { id?: string }).id);
    if (!id) return reply.code(404).send({ error: 'report not found', code: 'report_not_found' });

    const body = bodyOf(request.body);
    const nextStatus = String(body.status ?? '');
    if (nextStatus !== 'resolved' && nextStatus !== 'dismissed') {
      return reply
        .code(400)
        .send({ error: 'status must be resolved or dismissed', code: 'invalid_status' });
    }

    let note: string | null = null;
    try {
      note = optionalText(body.note, 1000);
    } catch {
      return reply.code(400).send({ error: 'note is too long', code: 'invalid_note' });
    }

    const report = ctx.sqlite
      .prepare(
        'SELECT id, post_id AS postId, reporter_id AS reporterId, status, reason FROM reports WHERE id = ?',
      )
      .get(id) as
      | {
          id: number;
          postId: number;
          reporterId: number | null;
          status: string;
          reason: string;
        }
      | undefined;
    if (!report)
      return reply.code(404).send({ error: 'report not found', code: 'report_not_found' });
    if (report.status !== 'open') {
      return reply.code(409).send({ error: 'report is already closed', code: 'report_closed' });
    }

    const hidePost = body.hidePost === true;
    const now = new Date().toISOString();

    const run = ctx.sqlite.transaction(() => {
      if (hidePost) {
        const post = ctx.sqlite
          .prepare('SELECT id, status, uploaded_by AS uploadedBy FROM posts WHERE id = ?')
          .get(report.postId) as
          { id: number; status: string; uploadedBy: number | null } | undefined;
        if (post) {
          const reason = isModerationReason(report.reason) ? report.reason : 'other';
          ctx.sqlite
            .prepare(
              `UPDATE posts
               SET status = 'hidden', moderated_by = ?, moderated_at = ?, rejection_reason = ?,
                   moderation_note = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(actor.id, now, reason, note, now, report.postId);
          writeAudit(ctx, actor.id, 'post.reject', 'post', report.postId, reason, note);
          notifyPostAuthor(
            ctx,
            post,
            'post_hidden',
            `Your post #${report.postId} was hidden: ${REASON_LABELS[reason]}.`,
          );
        }
      }

      ctx.sqlite
        .prepare(
          `UPDATE reports
           SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ?
           WHERE id = ?`,
        )
        .run(nextStatus, actor.id, now, note, id);
      writeAudit(
        ctx,
        actor.id,
        nextStatus === 'resolved' ? 'report.resolve' : 'report.dismiss',
        'report',
        id,
        report.reason,
        note,
      );
      notify(
        ctx,
        report.reporterId,
        'report_closed',
        report.postId,
        `Your report on post #${report.postId} was ${nextStatus}.`,
      );
    });
    run();

    return { report: getReport(ctx, id) };
  });

  app.get('/api/v1/admin/dnp', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;
    const rows = ctx.sqlite
      .prepare(
        `SELECT d.id, d.name, d.source_pattern AS sourcePattern, d.note, d.created_at AS createdAt,
                u.username AS createdBy
         FROM dnp_artists d LEFT JOIN users u ON u.id = d.created_by
         ORDER BY d.name ASC`,
      )
      .all() as DnpRow[];
    return { entries: rows };
  });

  app.post('/api/v1/admin/dnp', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const body = bodyOf(request.body);
    let name: string | null = null;
    try {
      name = optionalText(body.name, 100);
    } catch {
      return reply.code(400).send({ error: 'artist name is too long', code: 'invalid_text' });
    }
    if (!name)
      return reply.code(400).send({ error: 'artist name is required', code: 'name_required' });
    name = name
      .toLowerCase()
      .replace(/^artist:/, '')
      .replace(/\s+/g, '_');
    let sourcePattern: string | null = null;
    let note: string | null = null;
    try {
      sourcePattern = optionalText(body.sourcePattern, 300);
      note = optionalText(body.note, 500);
    } catch {
      return reply.code(400).send({ error: 'text is too long', code: 'invalid_text' });
    }

    const now = new Date().toISOString();
    try {
      const inserted = ctx.sqlite
        .prepare(
          `INSERT INTO dnp_artists (name, source_pattern, note, created_by, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(name, sourcePattern, note, actor.id, now);
      const id = Number(inserted.lastInsertRowid);
      writeAudit(ctx, actor.id, 'dnp.add', 'dnp', id, null, name);
      return reply.code(201).send({
        entry: { id, name, sourcePattern, note, createdAt: now, createdBy: actor.username },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return reply
          .code(409)
          .send({ error: 'artist is already on the DNP list', code: 'dnp_exists' });
      }
      throw error;
    }
  });

  app.delete('/api/v1/admin/dnp/:id', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const id = positiveInt((request.params as { id?: string }).id);
    if (!id) return reply.code(404).send({ error: 'DNP entry not found', code: 'dnp_not_found' });
    const row = ctx.sqlite.prepare('SELECT name FROM dnp_artists WHERE id = ?').get(id) as
      { name: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'DNP entry not found', code: 'dnp_not_found' });
    ctx.sqlite.prepare('DELETE FROM dnp_artists WHERE id = ?').run(id);
    writeAudit(ctx, actor.id, 'dnp.remove', 'dnp', id, null, row.name);
    return reply.code(204).send();
  });

  app.get('/api/v1/admin/uploaders', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const requests = ctx.sqlite
      .prepare(
        uploaderRequestSelect("WHERE r.status = 'pending' ORDER BY r.created_at ASC, r.id ASC"),
      )
      .all() as UploaderRequestAdminRow[];
    const uploaders = ctx.sqlite
      .prepare(
        `SELECT up.user_id AS userId, u.username, up.approved_at AS approvedAt,
                approver.username AS approvedBy, up.note,
                (SELECT COUNT(*) FROM posts p WHERE p.uploaded_by = up.user_id) AS postCount
         FROM uploaders up
         JOIN users u ON u.id = up.user_id
         LEFT JOIN users approver ON approver.id = up.approved_by
         ORDER BY u.username_lower ASC`,
      )
      .all() as UploaderEntryRow[];

    return { requests, uploaders };
  });

  app.patch('/api/v1/admin/uploader-requests/:id', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const id = positiveInt((request.params as { id?: string }).id);
    if (!id) {
      return reply
        .code(404)
        .send({ error: 'uploader request not found', code: 'uploader_request_not_found' });
    }

    const body = bodyOf(request.body);
    const nextStatus =
      body.status === 'approved' ? 'approved' : body.status === 'rejected' ? 'rejected' : null;
    if (!nextStatus) {
      return reply
        .code(400)
        .send({ error: 'status must be approved or rejected', code: 'invalid_status' });
    }

    let note: string | null = null;
    try {
      note = optionalText(body.note, 1000);
    } catch {
      return reply.code(400).send({ error: 'note is too long', code: 'invalid_note' });
    }

    const current = ctx.sqlite
      .prepare(
        `SELECT r.id, r.user_id AS userId, r.status, u.username
         FROM uploader_requests r JOIN users u ON u.id = r.user_id
         WHERE r.id = ?`,
      )
      .get(id) as { id: number; userId: number; status: string; username: string } | undefined;
    if (!current) {
      return reply
        .code(404)
        .send({ error: 'uploader request not found', code: 'uploader_request_not_found' });
    }
    if (current.status !== 'pending') {
      return reply
        .code(409)
        .send({ error: 'this application was already reviewed', code: 'request_closed' });
    }

    const now = new Date().toISOString();
    const run = ctx.sqlite.transaction(() => {
      ctx.sqlite
        .prepare(
          `UPDATE uploader_requests
           SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
           WHERE id = ?`,
        )
        .run(nextStatus, actor.id, now, note, id);

      if (nextStatus === 'approved') {
        ctx.sqlite
          .prepare(
            `INSERT INTO uploaders (user_id, approved_by, approved_at, note)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               approved_by = excluded.approved_by,
               approved_at = excluded.approved_at,
               note = excluded.note`,
          )
          .run(current.userId, actor.id, now, note);
      }

      writeAudit(
        ctx,
        actor.id,
        nextStatus === 'approved' ? 'uploader.approve' : 'uploader.reject',
        'user',
        current.userId,
        null,
        `@${current.username}${note ? `: ${note}` : ''}`,
      );
      notify(
        ctx,
        current.userId,
        nextStatus === 'approved' ? 'uploader_approved' : 'uploader_rejected',
        null,
        nextStatus === 'approved'
          ? 'Your uploader application was approved. You can now upload artwork.'
          : `Your uploader application was rejected.${note ? ` Note: ${note}` : ''}`,
      );
    });
    run();

    const row = ctx.sqlite.prepare(uploaderRequestSelect('WHERE r.id = ?')).get(id) as
      UploaderRequestAdminRow | undefined;
    return { request: row ?? null };
  });

  app.delete('/api/v1/admin/uploaders/:userId', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const userId = positiveInt((request.params as { userId?: string }).userId);
    if (!userId) {
      return reply.code(404).send({ error: 'uploader not found', code: 'uploader_not_found' });
    }

    const row = ctx.sqlite
      .prepare(
        `SELECT up.user_id AS userId, u.username FROM uploaders up
         JOIN users u ON u.id = up.user_id WHERE up.user_id = ?`,
      )
      .get(userId) as { userId: number; username: string } | undefined;
    if (!row) {
      return reply.code(404).send({ error: 'uploader not found', code: 'uploader_not_found' });
    }

    ctx.sqlite.prepare('DELETE FROM uploaders WHERE user_id = ?').run(userId);
    writeAudit(ctx, actor.id, 'uploader.revoke', 'user', userId, null, `@${row.username}`);
    notify(
      ctx,
      userId,
      'uploader_revoked',
      null,
      'Your uploader access was revoked. You can apply again if you think this was a mistake.',
    );
    return reply.code(204).send();
  });

  app.get('/api/v1/admin/sources', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const runs = ctx.sqlite
      .prepare(`${SOURCE_RUN_SELECT} ORDER BY r.created_at DESC, r.id DESC LIMIT 30`)
      .all() as SourceRunRow[];
    return {
      sources: SOURCE_NAMES,
      schedules: listSourceSchedules(ctx),
      runs: runs.map(sourceRunDto),
    };
  });

  app.patch('/api/v1/admin/source-schedules/:source', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const source = String((request.params as { source?: string }).source ?? '').toLowerCase();
    if (!SOURCE_NAMES.includes(source as SourceName)) {
      return reply.code(400).send({ error: 'unknown source', code: 'unknown_source' });
    }

    const body = bodyOf(request.body);
    const patch: SourceSchedulePatch = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled must be boolean', code: 'invalid_schedule' });
      }
      patch.enabled = body.enabled;
    }

    for (const [field, min, max] of [
      ['intervalMinutes', 5, 24 * 60],
      ['batchLimit', 1, 200],
      ['dailyLimit', 0, 10_000],
    ] as const) {
      if (body[field] === undefined) continue;
      const parsed = boundedInt(body[field], 0, min, max);
      if (parsed === null) {
        return reply
          .code(400)
          .send({ error: `${field} is out of range`, code: 'invalid_schedule' });
      }
      patch[field] = parsed;
    }

    if (body.tags !== undefined) {
      if (body.tags !== null && typeof body.tags !== 'string') {
        return reply.code(400).send({ error: 'tags must be text', code: 'invalid_tags' });
      }
      const tags = typeof body.tags === 'string' ? body.tags.trim() : '';
      if (tags.length > 500) {
        return reply
          .code(400)
          .send({ error: 'tags query is longer than 500 characters', code: 'invalid_tags' });
      }
      patch.tags = tags || null;
    }

    if (body.reset !== undefined) {
      if (typeof body.reset !== 'boolean') {
        return reply.code(400).send({ error: 'reset must be boolean', code: 'invalid_schedule' });
      }
      patch.reset = body.reset;
    }

    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'nothing to update', code: 'no_changes' });
    }

    const schedule = updateSourceSchedule(ctx, source, patch);
    if (!schedule) {
      return reply.code(404).send({ error: 'source schedule not found', code: 'not_found' });
    }
    writeAudit(
      ctx,
      actor.id,
      'source.schedule',
      'source',
      null,
      null,
      `${source}: ${JSON.stringify(patch)}`,
    );
    return { schedule };
  });

  app.post('/api/v1/admin/source-runs', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const body = bodyOf(request.body);
    const source = typeof body.source === 'string' ? body.source.trim().toLowerCase() : 'danbooru';
    if (!SOURCE_NAMES.includes(source as SourceName)) {
      return reply.code(400).send({ error: 'unknown source', code: 'unknown_source' });
    }

    let tags: string | null = null;
    if (body.tags !== undefined && body.tags !== null) {
      if (typeof body.tags !== 'string') {
        return reply.code(400).send({ error: 'tags must be text', code: 'invalid_tags' });
      }
      tags = body.tags.trim();
      if (tags.length > 500) {
        return reply
          .code(400)
          .send({ error: 'tags query is longer than 500 characters', code: 'invalid_tags' });
      }
      if (!tags) tags = null;
    }

    const limit = boundedInt(body.limit, 40, 1, 500);
    const page = boundedInt(body.page, 1, 1, 100_000);
    const pageSize = boundedInt(body.pageSize, 50, 1, 200);
    const delayMs = boundedInt(body.delayMs, 1100, 0, 10_000);
    if (limit === null || page === null || pageSize === null || delayMs === null) {
      return reply.code(400).send({ error: 'invalid run limits', code: 'invalid_limits' });
    }

    const active = ctx.sqlite
      .prepare(
        "SELECT id FROM source_runs WHERE source = ? AND status IN ('queued', 'running') LIMIT 1",
      )
      .get(source) as { id: number } | undefined;
    if (active) {
      return reply
        .code(409)
        .send({ error: 'this source already has an active run', code: 'source_busy' });
    }

    const now = new Date().toISOString();
    const create = ctx.sqlite.transaction(() => {
      const inserted = ctx.sqlite
        .prepare(
          `INSERT INTO source_runs
            (source, tags, limit_count, page, page_size, delay_ms, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        )
        .run(source, tags, limit, page, pageSize, delayMs, actor.id, now);
      const runId = Number(inserted.lastInsertRowid);
      writeSourceRunLog(ctx, runId, 'info', `Queued by @${actor.username}.`);
      writeAudit(
        ctx,
        actor.id,
        'source.run',
        'source_run',
        runId,
        null,
        `${source}${tags ? ` [${tags}]` : ''} · limit ${limit} · page ${page}`,
      );
      return runId;
    });
    const runId = create();

    enqueueJob(ctx.sqlite, 'source_import', { runId });
    void processSourceJobs(ctx).catch((error) =>
      ctx.log.error('source worker failed', { err: error }),
    );
    return reply.code(201).send({ run: getSourceRun(ctx, runId) });
  });

  app.get('/api/v1/admin/source-runs/:id', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const id = positiveInt((request.params as { id?: string }).id);
    if (!id)
      return reply.code(404).send({ error: 'source run not found', code: 'source_run_not_found' });
    const run = getSourceRun(ctx, id);
    if (!run)
      return reply.code(404).send({ error: 'source run not found', code: 'source_run_not_found' });

    const query = request.query as Record<string, string | undefined>;
    const after = Math.max(Math.floor(Number(query.after) || 0), 0);
    const logs = ctx.sqlite
      .prepare(
        `SELECT id, level, message, created_at AS createdAt
         FROM source_run_logs
         WHERE run_id = ? AND id > ?
         ORDER BY id ASC
         LIMIT 1000`,
      )
      .all(id, after) as SourceRunLogRow[];

    return { run, logs };
  });

  app.post('/api/v1/admin/source-runs/:id/cancel', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const id = positiveInt((request.params as { id?: string }).id);
    if (!id)
      return reply.code(404).send({ error: 'source run not found', code: 'source_run_not_found' });
    const row = ctx.sqlite
      .prepare('SELECT id, status, source FROM source_runs WHERE id = ?')
      .get(id) as { id: number; status: string; source: string } | undefined;
    if (!row)
      return reply.code(404).send({ error: 'source run not found', code: 'source_run_not_found' });
    if (row.status !== 'queued' && row.status !== 'running') {
      return reply
        .code(409)
        .send({ error: 'this run cannot be cancelled', code: 'run_not_cancellable' });
    }

    const now = new Date().toISOString();
    const cancel = ctx.sqlite.transaction(() => {
      if (row.status === 'queued') {
        ctx.sqlite
          .prepare(
            `UPDATE source_runs
             SET status = 'cancelled', cancel_requested = 1, finished_at = ?
             WHERE id = ?`,
          )
          .run(now, id);
        writeSourceRunLog(ctx, id, 'warn', `Cancelled before start by @${actor.username}.`);
      } else {
        ctx.sqlite.prepare('UPDATE source_runs SET cancel_requested = 1 WHERE id = ?').run(id);
        writeSourceRunLog(
          ctx,
          id,
          'warn',
          `Cancellation requested by @${actor.username}; stopping after the current request.`,
        );
      }
      writeAudit(ctx, actor.id, 'source.cancel', 'source_run', id, null, row.source);
    });
    cancel();

    return { run: getSourceRun(ctx, id) };
  });

  app.get('/api/v1/admin/audit', async (request, reply) => {
    const actor = moderatorsOnly(ctx, request, reply);
    if (!actor) return;

    const query = request.query as Record<string, string | undefined>;
    const { page, limit, offset } = pageParams(query, 50);
    const total = ctx.sqlite.prepare('SELECT COUNT(*) AS count FROM audit_log').get() as {
      count: number;
    };
    const rows = ctx.sqlite
      .prepare(
        `SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
                a.reason, a.details, a.created_at AS createdAt, u.username AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as AuditRow[];
    return { page, limit, total: total.count, entries: rows };
  });

  app.post('/api/v1/posts/:id/reports', async (request, reply) => {
    const user = currentUser(ctx.sqlite, request);
    if (!user) return reply.code(401).send({ error: 'sign in to report', code: 'auth_required' });

    const limited = rateLimited(limiter, request, reply, 'report', `user:${user.id}`);
    if (limited) return limited;

    const postId = positiveInt((request.params as { id?: string }).id);
    if (!postId) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });
    const post = ctx.sqlite
      .prepare("SELECT id FROM posts WHERE id = ? AND status = 'active'")
      .get(postId);
    if (!post) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    const body = bodyOf(request.body);
    const reason = body.reason;
    if (!isModerationReason(reason)) {
      return reply.code(400).send({ error: 'unknown report reason', code: 'invalid_reason' });
    }
    let note: string | null = null;
    try {
      note = optionalText(body.body, 1000);
    } catch {
      return reply.code(400).send({ error: 'report is too long', code: 'invalid_body' });
    }

    const now = new Date().toISOString();
    try {
      const inserted = ctx.sqlite
        .prepare(
          `INSERT INTO reports (post_id, reporter_id, reason, body, status, created_at)
           VALUES (?, ?, ?, ?, 'open', ?)`,
        )
        .run(postId, user.id, reason, note, now);
      const id = Number(inserted.lastInsertRowid);
      writeAudit(ctx, user.id, 'report.create', 'report', id, reason, note);
      return reply.code(201).send({ report: getReport(ctx, id) });
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return reply.code(409).send({
          error: 'you already have an open report for this post',
          code: 'already_reported',
        });
      }
      throw error;
    }
  });

  // Keep the reason list discoverable for clients without importing server code.
  app.get('/api/v1/report-reasons', async () => ({ reasons: MODERATION_REASONS }));
}
