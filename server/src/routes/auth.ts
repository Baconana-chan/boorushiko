import type { FastifyInstance } from 'fastify';
import {
  burnPasswordCheck,
  clearSessionCookie,
  createSession,
  currentUser,
  deleteSession,
  hashPassword,
  isValidPassword,
  normalizeUsername,
  readSessionToken,
  setSessionCookie,
  verifyPassword,
  type SessionUser,
} from '../auth.js';
import type { EngineContext } from '../context.js';
import { rateLimited, type RateLimiter } from '../rate-limit.js';
import { AttemptThrottle } from '../throttle.js';
import { canUpload as userCanUpload } from '../uploaders.js';

interface AuthBody {
  username?: unknown;
  password?: unknown;
}

interface UserRow extends SessionUser {
  passwordHash: string;
}

function bodyOf(value: unknown): AuthBody {
  return value !== null && typeof value === 'object' ? (value as AuthBody) : {};
}

function userDto(ctx: EngineContext, user: SessionUser) {
  const karma = ctx.sqlite
    .prepare('SELECT COALESCE(SUM(score), 0) AS karma FROM comments WHERE user_id = ?')
    .get(user.id) as { karma: number };
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    canUpload: userCanUpload(ctx.sqlite, user),
    commentKarma: karma.karma,
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  ctx: EngineContext,
  limiter: RateLimiter,
): void {
  // Ten failed passwords per address+name per fifteen minutes.
  const throttle = new AttemptThrottle(10, 15 * 60 * 1000);

  app.get('/api/v1/auth/me', async (request) => {
    const user = currentUser(ctx.sqlite, request);
    return { user: user ? userDto(ctx, user) : null };
  });

  app.post('/api/v1/auth/register', async (request, reply) => {
    const limited = rateLimited(limiter, request, reply, 'register');
    if (limited) return limited;

    const body = bodyOf(request.body);
    const username = normalizeUsername(body.username);
    if (!username) {
      return reply.code(400).send({
        error: 'username must be 3-24 lowercase letters, digits or underscore',
        code: 'invalid_username',
      });
    }
    if (!isValidPassword(body.password)) {
      return reply
        .code(400)
        .send({ error: 'password must be between 8 and 200 characters', code: 'weak_password' });
    }

    const taken = ctx.sqlite.prepare('SELECT 1 FROM users WHERE username_lower = ?').get(username);
    if (taken) {
      return reply.code(409).send({ error: 'username is already taken', code: 'username_taken' });
    }

    const createdAt = new Date().toISOString();
    const passwordHash = await hashPassword(body.password);

    let userId: number;
    try {
      const inserted = ctx.sqlite
        .prepare(
          `INSERT INTO users (username, username_lower, password_hash, role, created_at)
           VALUES (?, ?, ?, 'user', ?)`,
        )
        .run(username, username, passwordHash, createdAt);
      userId = Number(inserted.lastInsertRowid);
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return reply.code(409).send({ error: 'username is already taken', code: 'username_taken' });
      }
      throw error;
    }

    const user: SessionUser = { id: userId, username, role: 'user', createdAt };
    const token = createSession(ctx.sqlite, userId, ctx.config);
    setSessionCookie(reply, token, ctx.config);
    return reply.code(201).send({ user: userDto(ctx, user) });
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = bodyOf(request.body);
    const username = normalizeUsername(body.username);
    const password =
      typeof body.password === 'string' && body.password.length <= 200 ? body.password : '';

    const attempted =
      typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 32) : '';
    const throttleKey = `${request.ip}:${attempted}`;
    if (throttle.isBlocked(throttleKey)) {
      return reply
        .code(429)
        .send({ error: 'too many login attempts, wait a few minutes', code: 'slow_down' });
    }

    const row = username
      ? (ctx.sqlite
          .prepare(
            `SELECT id, username, role, created_at AS createdAt, password_hash AS passwordHash
             FROM users WHERE username_lower = ?`,
          )
          .get(username) as UserRow | undefined)
      : undefined;

    let valid = false;
    if (row) {
      valid = await verifyPassword(password, row.passwordHash);
    } else {
      await burnPasswordCheck(password);
    }

    if (!row || !valid) {
      throttle.fail(throttleKey);
      return reply
        .code(401)
        .send({ error: 'wrong username or password', code: 'invalid_credentials' });
    }

    throttle.reset(throttleKey);
    const token = createSession(ctx.sqlite, row.id, ctx.config);
    setSessionCookie(reply, token, ctx.config);
    return { user: userDto(ctx, row) };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const token = readSessionToken(request);
    if (token) deleteSession(ctx.sqlite, token);
    clearSessionCookie(reply, ctx.config);
    return reply.code(204).send();
  });
}
