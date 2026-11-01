import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestContext, seedPost } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp(overrides: Parameters<typeof createTestContext>[0] = {}) {
  const context = createTestContext(overrides);
  const app = buildApp(context.ctx);
  apps.push(app);
  return { ...context, app };
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error('missing session cookie');
  return value.split(';')[0]!;
}

async function signUp(app: FastifyInstance, username: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password: 'password123' },
  });
}

describe('request perimeter', () => {
  it('rejects cross-origin mutations and accepts same-origin browsers and token clients', async () => {
    const { app } = makeApp({ publicBaseUrl: 'https://booru.example' });

    const evilOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { origin: 'https://evil.example' },
      payload: { username: 'victim', password: 'password123' },
    });
    expect(evilOrigin.statusCode).toBe(403);
    expect(evilOrigin.json().code).toBe('cross_origin');

    const evilReferer = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { referer: 'https://evil.example/page.html' },
      payload: { username: 'victim', password: 'password123' },
    });
    expect(evilReferer.statusCode).toBe(403);

    const nullOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'null' },
      payload: {},
    });
    expect(nullOrigin.statusCode).toBe(403);

    const allowed = await signUp(app, 'same_origin');
    expect(allowed.statusCode).toBe(201);

    const proxyHost = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: 'http://beta.example', host: 'beta.example' },
    });
    expect(proxyHost.statusCode).toBe(204);

    // X-Forwarded-Host is what Caddy passes when the origin is not PUBLIC_BASE_URL.
    const forwarded = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: 'https://other.example', 'x-forwarded-host': 'other.example' },
    });
    expect(forwarded.statusCode).toBe(204);

    // Scripts and the parser send no Origin/Referer at all.
    const script = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'nobody', password: 'password123' },
    });
    expect(script.statusCode).toBe(401);

    // Reads are never blocked, even from another origin.
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/posts',
      headers: { origin: 'https://evil.example' },
    });
    expect(read.statusCode).toBe(200);
  });

  it('throttles registrations per address', async () => {
    const { app } = makeApp({ rateLimitEnabled: true });

    for (let index = 0; index < 5; index += 1) {
      expect((await signUp(app, `member_${index}`)).statusCode).toBe(201);
    }

    const blocked = await signUp(app, 'member_5');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('throttles reports per user without touching other accounts', async () => {
    const { ctx, app } = makeApp({ rateLimitEnabled: true });

    const first = await signUp(app, 'reporter');
    const second = await signUp(app, 'bystander');
    const cookie = cookieFrom(first);
    const otherCookie = cookieFrom(second);

    const posts = Array.from({ length: 11 }, (_unused, index) =>
      seedPost(ctx, { md5: String(index + 1).padStart(32, 'a') }),
    );

    for (const postId of posts.slice(0, 10)) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${postId}/reports`,
        headers: { cookie },
        payload: { reason: 'ai' },
      });
      expect(response.statusCode).toBe(201);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${posts[10]}/reports`,
      headers: { cookie },
      payload: { reason: 'ai' },
    });
    expect(blocked.statusCode).toBe(429);

    const otherUser = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${posts[10]}/reports`,
      headers: { cookie: otherCookie },
      payload: { reason: 'ai' },
    });
    expect(otherUser.statusCode).toBe(201);
  });

  it('rejects oversized JSON bodies before a handler runs', async () => {
    const { app } = makeApp({ bodyLimitBytes: 1024 });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'someone', password: 'x'.repeat(4096) },
    });
    expect(response.statusCode).toBe(413);
  });
});
