import type { FastifyInstance, FastifyReply } from 'fastify';
import { currentUser, type Role } from '../auth.js';
import {
  COMMENT_MAX_LENGTH,
  validateCommentBody,
  type CommentValidationCode,
} from '../comments.js';
import type { EngineContext } from '../context.js';
import { rateLimited, type RateLimiter } from '../rate-limit.js';

interface CommentRow {
  id: number;
  body: string;
  score: number;
  voteCount: number;
  myVote: number | null;
  authorKarma: number;
  createdAt: string;
  updatedAt: string;
  userId: number;
  username: string;
  role: Role;
}

interface CommentDto {
  id: number;
  body: string;
  score: number;
  voteCount: number;
  hidden: boolean;
  myVote: -1 | 0 | 1;
  authorKarma: number;
  createdAt: string;
  updatedAt: string;
  user: { id: number; username: string; role: Role };
}

// The first parameter is always the viewer id for `myVote`; callers that do
// not have a session pass 0, which matches no vote.
const COMMENT_SELECT = `SELECT c.id, c.body, c.score, c.vote_count AS voteCount,
       (SELECT v.value FROM comment_votes v
        WHERE v.comment_id = c.id AND v.user_id = ? LIMIT 1) AS myVote,
       (SELECT COALESCE(SUM(k.score), 0) FROM comments k WHERE k.user_id = u.id) AS authorKarma,
       c.created_at AS createdAt, c.updated_at AS updatedAt,
       u.id AS userId, u.username, u.role
  FROM comments c JOIN users u ON u.id = c.user_id`;

const VALIDATION_MESSAGES: Record<CommentValidationCode, string> = {
  comment_empty: 'comment is empty',
  comment_too_long: `comment is longer than ${COMMENT_MAX_LENGTH} characters`,
  link_not_allowed: 'links are not allowed in comments',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function retryAfterSeconds(isoDate: string, windowMs: number): number {
  return Math.max(1, Math.ceil((Date.parse(isoDate) + windowMs - Date.now()) / 1000));
}

function tooManyVotes(
  reply: FastifyReply,
  code: 'vote_slow_down' | 'vote_limit',
  seconds: number,
): unknown {
  const message = code === 'vote_limit' ? 'daily vote limit reached' : 'voting too fast';
  return reply
    .header('retry-after', String(seconds))
    .code(429)
    .send({ error: message, code, retryAfterSeconds: seconds });
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function toDto(row: CommentRow, ctx: EngineContext): CommentDto {
  return {
    id: row.id,
    body: row.body,
    score: row.score,
    voteCount: row.voteCount,
    hidden:
      ctx.config.commentHideMinVotes > 0
        ? row.voteCount >= ctx.config.commentHideMinVotes &&
          row.score <= ctx.config.commentHideScore
        : row.score <= ctx.config.commentHideScore,
    myVote: row.myVote === 1 || row.myVote === -1 ? row.myVote : 0,
    authorKarma: row.authorKarma,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    user: { id: row.userId, username: row.username, role: row.role },
  };
}

function commentRow(ctx: EngineContext, id: number, viewerId: number): CommentRow | undefined {
  return ctx.sqlite.prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(viewerId, id) as
    CommentRow | undefined;
}

export function registerCommentRoutes(
  app: FastifyInstance,
  ctx: EngineContext,
  limiter: RateLimiter,
): void {
  app.get('/api/v1/posts/:id/comments', async (request, reply) => {
    const postId = positiveInt((request.params as { id?: string }).id);
    if (!postId) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    const post = ctx.sqlite
      .prepare("SELECT id FROM posts WHERE id = ? AND status = 'active'")
      .get(postId);
    if (!post) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    const query = request.query as Record<string, string | undefined>;
    const requestedLimit = Number(query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 100)
      : 30;
    const beforeId = positiveInt(query.before);
    const viewer = currentUser(ctx.sqlite, request);

    const conditions = ['c.post_id = ?'];
    const params: Array<string | number> = [viewer?.id ?? 0, postId];
    if (beforeId) {
      conditions.push('c.id < ?');
      params.push(beforeId);
    }
    params.push(limit + 1);

    const rows = ctx.sqlite
      .prepare(`${COMMENT_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY c.id DESC LIMIT ?`)
      .all(...params) as CommentRow[];

    const hasMore = rows.length > limit;
    const comments = rows
      .slice(0, limit)
      .reverse()
      .map((row) => toDto(row, ctx));
    const total = ctx.sqlite
      .prepare('SELECT COUNT(*) AS count FROM comments WHERE post_id = ?')
      .get(postId) as { count: number };

    return { comments, hasMore, total: total.count };
  });

  app.post('/api/v1/posts/:id/comments', async (request, reply) => {
    const postId = positiveInt((request.params as { id?: string }).id);
    if (!postId) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    const user = currentUser(ctx.sqlite, request);
    if (!user) return reply.code(401).send({ error: 'sign in to comment', code: 'auth_required' });

    const limited = rateLimited(limiter, request, reply, 'comment', `user:${user.id}`);
    if (limited) return limited;

    const post = ctx.sqlite
      .prepare("SELECT id FROM posts WHERE id = ? AND status = 'active'")
      .get(postId);
    if (!post) return reply.code(404).send({ error: 'post not found', code: 'post_not_found' });

    const body = request.body as { body?: unknown } | undefined;
    const validation = validateCommentBody(body?.body);
    if (!validation.ok) {
      return reply
        .code(400)
        .send({ error: VALIDATION_MESSAGES[validation.code], code: validation.code });
    }

    if (ctx.config.commentCooldownSeconds > 0) {
      const last = ctx.sqlite
        .prepare(
          'SELECT created_at AS createdAt FROM comments WHERE user_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(user.id) as { createdAt: string } | undefined;
      if (last) {
        const waitMs =
          ctx.config.commentCooldownSeconds * 1000 - (Date.now() - Date.parse(last.createdAt));
        if (waitMs > 0) {
          return reply.code(429).send({
            error: 'commenting too fast',
            code: 'slow_down',
            retryAfterSeconds: Math.ceil(waitMs / 1000),
          });
        }
      }
    }

    const now = new Date().toISOString();
    const inserted = ctx.sqlite
      .prepare(
        `INSERT INTO comments (post_id, user_id, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(postId, user.id, validation.body, now, now);
    const row = commentRow(ctx, Number(inserted.lastInsertRowid), user.id)!;

    return reply.code(201).send({ comment: toDto(row, ctx) });
  });

  app.post('/api/v1/comments/:id/vote', async (request, reply) => {
    const commentId = positiveInt((request.params as { id?: string }).id);
    if (!commentId) {
      return reply.code(404).send({ error: 'comment not found', code: 'comment_not_found' });
    }

    const user = currentUser(ctx.sqlite, request);
    if (!user) return reply.code(401).send({ error: 'sign in to vote', code: 'auth_required' });

    const body = request.body as { value?: unknown } | undefined;
    const value = Number(body?.value);
    if (!Number.isInteger(value) || (value !== -1 && value !== 0 && value !== 1)) {
      return reply.code(400).send({ error: 'vote must be -1, 0 or 1', code: 'invalid_vote' });
    }

    const target = ctx.sqlite
      .prepare('SELECT user_id AS userId FROM comments WHERE id = ?')
      .get(commentId) as { userId: number } | undefined;
    if (!target) {
      return reply.code(404).send({ error: 'comment not found', code: 'comment_not_found' });
    }
    if (target.userId === user.id) {
      return reply.code(403).send({ error: 'cannot vote for your own comment', code: 'self_vote' });
    }

    const existing = ctx.sqlite
      .prepare('SELECT value FROM comment_votes WHERE comment_id = ? AND user_id = ?')
      .get(commentId, user.id) as { value: number } | undefined;

    // Re-sending the current vote is a read, not an action: it must not consume
    // the daily quota or trip the cooldown.
    if ((existing?.value ?? 0) === value) {
      return { comment: toDto(commentRow(ctx, commentId, user.id)!, ctx) };
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const dayCutoff = new Date(nowMs - DAY_MS).toISOString();

    if (value !== 0) {
      if (ctx.config.commentVoteCooldownSeconds > 0) {
        const lastAction = ctx.sqlite
          .prepare(
            `SELECT created_at AS createdAt FROM comment_vote_actions
             WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(user.id) as { createdAt: string } | undefined;
        if (lastAction) {
          const waitMs =
            ctx.config.commentVoteCooldownSeconds * 1000 -
            (nowMs - Date.parse(lastAction.createdAt));
          if (waitMs > 0) {
            return tooManyVotes(reply, 'vote_slow_down', Math.ceil(waitMs / 1000));
          }
        }
      }

      if (ctx.config.commentVoteDailyLimit > 0) {
        const used = ctx.sqlite
          .prepare(
            'SELECT COUNT(*) AS count FROM comment_vote_actions WHERE user_id = ? AND created_at >= ?',
          )
          .get(user.id, dayCutoff) as { count: number };
        if (used.count >= ctx.config.commentVoteDailyLimit) {
          const oldest = ctx.sqlite
            .prepare(
              `SELECT MIN(created_at) AS createdAt FROM comment_vote_actions
               WHERE user_id = ? AND created_at >= ?`,
            )
            .get(user.id, dayCutoff) as { createdAt: string | null };
          const seconds = oldest.createdAt ? retryAfterSeconds(oldest.createdAt, DAY_MS) : 3600;
          return tooManyVotes(reply, 'vote_limit', seconds);
        }
      }

      // A downvote is blocked when the comment author already has an active
      // downvote on one of the voter's comments inside the window. The first
      // downvote is allowed; this only stops the immediate reply chain.
      if (value === -1 && ctx.config.commentMutualDownvoteHours > 0) {
        const mutualCutoff = new Date(
          nowMs - ctx.config.commentMutualDownvoteHours * 60 * 60 * 1000,
        ).toISOString();
        const mutual = ctx.sqlite
          .prepare(
            `SELECT 1 FROM comment_votes v JOIN comments c ON c.id = v.comment_id
             WHERE v.user_id = ? AND v.value = -1 AND c.user_id = ? AND v.updated_at >= ?
             LIMIT 1`,
          )
          .get(target.userId, user.id, mutualCutoff);
        if (mutual) {
          return reply.code(409).send({
            error: 'cannot answer a downvote with another downvote',
            code: 'mutual_downvote',
          });
        }
      }
    }

    const weight = user.role === 'user' ? 1 : ctx.config.commentModVoteWeight;
    const vote = ctx.sqlite.transaction(() => {
      if (value === 0) {
        ctx.sqlite
          .prepare('DELETE FROM comment_votes WHERE comment_id = ? AND user_id = ?')
          .run(commentId, user.id);
      } else {
        ctx.sqlite
          .prepare(
            `INSERT INTO comment_votes (comment_id, user_id, value, weight, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(comment_id, user_id) DO UPDATE SET
               value = excluded.value,
               weight = excluded.weight,
               updated_at = excluded.updated_at`,
          )
          .run(commentId, user.id, value, weight, now, now);
        ctx.sqlite
          .prepare(
            `INSERT INTO comment_vote_actions (user_id, comment_id, value, created_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(user.id, commentId, value, now);
      }

      const totals = ctx.sqlite
        .prepare(
          `SELECT COALESCE(SUM(value * weight), 0) AS score, COUNT(*) AS voteCount
           FROM comment_votes WHERE comment_id = ?`,
        )
        .get(commentId) as { score: number; voteCount: number };
      ctx.sqlite
        .prepare('UPDATE comments SET score = ?, vote_count = ? WHERE id = ?')
        .run(totals.score, totals.voteCount, commentId);

      // Keep only the history the configured windows can still read.
      const retentionHours = Math.max(24, ctx.config.commentMutualDownvoteHours);
      ctx.sqlite
        .prepare('DELETE FROM comment_vote_actions WHERE created_at < ?')
        .run(new Date(nowMs - retentionHours * 60 * 60 * 1000).toISOString());
    });
    vote();

    return { comment: toDto(commentRow(ctx, commentId, user.id)!, ctx) };
  });

  app.delete('/api/v1/comments/:id', async (request, reply) => {
    const commentId = positiveInt((request.params as { id?: string }).id);
    if (!commentId) {
      return reply.code(404).send({ error: 'comment not found', code: 'comment_not_found' });
    }

    const user = currentUser(ctx.sqlite, request);
    if (!user) return reply.code(401).send({ error: 'sign in first', code: 'auth_required' });

    const row = ctx.sqlite
      .prepare('SELECT user_id AS userId FROM comments WHERE id = ?')
      .get(commentId) as { userId: number } | undefined;
    if (!row) {
      return reply.code(404).send({ error: 'comment not found', code: 'comment_not_found' });
    }

    if (row.userId !== user.id && user.role === 'user') {
      return reply
        .code(403)
        .send({ error: 'cannot delete another user comment', code: 'forbidden' });
    }

    ctx.sqlite.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
    return reply.code(204).send();
  });
}
