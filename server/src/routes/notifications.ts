import type { FastifyInstance } from 'fastify';
import { currentUser } from '../auth.js';
import type { EngineContext } from '../context.js';

export function registerNotificationRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get('/api/v1/me/notifications', async (request, reply) => {
    const user = currentUser(ctx.sqlite, request);
    if (!user) return reply.code(401).send({ error: 'sign in first', code: 'auth_required' });

    const notifications = ctx.sqlite
      .prepare(
        `SELECT id, kind, post_id AS postId, body, read_at AS readAt, created_at AS createdAt
         FROM notifications WHERE user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 30`,
      )
      .all(user.id);
    const unread = ctx.sqlite
      .prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL')
      .get(user.id) as { count: number };

    return { notifications, unread: unread.count };
  });

  app.post('/api/v1/me/notifications/read', async (request, reply) => {
    const user = currentUser(ctx.sqlite, request);
    if (!user) return reply.code(401).send({ error: 'sign in first', code: 'auth_required' });

    ctx.sqlite
      .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), user.id);
    return { unread: 0 };
  });
}
