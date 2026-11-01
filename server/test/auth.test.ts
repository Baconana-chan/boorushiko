import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestContext } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp(overrides: Parameters<typeof createTestContext>[0] = {}) {
  const context = createTestContext({ commentCooldownSeconds: 0, ...overrides });
  const app = buildApp(context.ctx);
  apps.push(app);
  return { ...context, app };
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : (raw ?? '');
  return value.split(';')[0] ?? '';
}

async function register(app: FastifyInstance, username: string, password = 'correct-horse') {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password },
  });
}

describe('accounts', () => {
  it('registers a user, sets a session cookie and returns it via /me', async () => {
    const { app } = makeApp();
    const response = await register(app, 'Artist_1');

    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({ username: 'artist_1', role: 'user' });

    const cookie = cookieFrom(response);
    expect(cookie).toMatch(/^boorushiko_session=.+/);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ username: 'artist_1', role: 'user' });
  });

  it('rejects duplicate names regardless of case and validates credentials', async () => {
    const { app } = makeApp();
    expect((await register(app, 'duplicate')).statusCode).toBe(201);

    const duplicate = await register(app, 'DUPLICATE');
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('username_taken');

    const shortPassword = await register(app, 'other_user', 'short');
    expect(shortPassword.statusCode).toBe(400);
    expect(shortPassword.json().code).toBe('weak_password');

    const badName = await register(app, 'no spaces here');
    expect(badName.statusCode).toBe(400);
    expect(badName.json().code).toBe('invalid_username');
  });

  it('logs in, rejects a bad password and logs out', async () => {
    const { app } = makeApp();
    await register(app, 'login_user');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'login_user', password: 'wrong-password' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe('invalid_credentials');

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'LOGIN_USER', password: 'correct-horse' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieFrom(login);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.json().user.username).toBe('login_user');

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(cookieFrom(logout)).toBe('boorushiko_session=');

    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(after.json().user).toBeNull();
  });

  it('returns an anonymous user instead of failing /me', async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toBeNull();
  });

  it('ignores a malformed session cookie', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: 'boorushiko_session=%' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toBeNull();
  });

  it('adds Secure to the cookie when configured', async () => {
    const { app } = makeApp({ cookieSecure: true });
    const response = await register(app, 'secure_user');
    expect(response.headers['set-cookie']).toContain('Secure');
  });
});
