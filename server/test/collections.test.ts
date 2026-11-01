import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestContext, seedPost } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp() {
  const context = createTestContext({ commentCooldownSeconds: 0 });
  const app = buildApp(context.ctx);
  apps.push(app);
  return { ...context, app };
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : (raw ?? '');
  return value.split(';')[0] ?? '';
}

async function signUp(app: FastifyInstance, username: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password: 'correct-horse' },
  });
  return { cookie: cookieFrom(response), userId: response.json().user.id as number };
}

function makeStaff(ctx: ReturnType<typeof createTestContext>['ctx'], username: string, role = 'moderator') {
  ctx.sqlite
    .prepare('UPDATE users SET role = ? WHERE username_lower = ?')
    .run(role, username.toLowerCase());
}

describe('favorites', () => {
  it('requires a session and toggles one row per user and post', async () => {
    const { app, ctx } = makeApp();
    const postId = seedPost(ctx, { md5: 'a'.repeat(32), tags: ['cat'] });

    const guest = await app.inject({ method: 'POST', url: `/api/v1/posts/${postId}/favorite` });
    expect(guest.statusCode).toBe(401);
    expect(guest.json().code).toBe('auth_required');

    const { cookie } = await signUp(app, 'fan_one');
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/favorite`,
      headers: { cookie },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toEqual({ favorited: true, favoriteCount: 1 });

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/favorite`,
      headers: { cookie },
    });
    expect(repeated.json()).toEqual({ favorited: true, favoriteCount: 1 });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` });
    expect(detail.json()).toMatchObject({ favorited: false, favoriteCount: 1 });

    const signedInDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}`,
      headers: { cookie },
    });
    expect(signedInDetail.json().favorited).toBe(true);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/posts/${postId}/favorite`,
      headers: { cookie },
    });
    expect(removed.json()).toEqual({ favorited: false, favoriteCount: 0 });
  });

  it('lists only this user’s active favorites, newest first', async () => {
    const { app, ctx } = makeApp();
    const older = seedPost(ctx, {
      md5: 'b'.repeat(32),
      tags: ['dog'],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = seedPost(ctx, {
      md5: 'c'.repeat(32),
      tags: ['bird'],
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const hidden = seedPost(ctx, { md5: 'd'.repeat(32), tags: ['fish'], status: 'hidden' });

    const { cookie } = await signUp(app, 'fan_two');
    for (const id of [older, newer, hidden]) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/posts/${id}/favorite`,
        headers: { cookie },
      });
    }
    // Force a deterministic order: the loop above runs in the same millisecond.
    ctx.sqlite
      .prepare('UPDATE favorites SET created_at = ? WHERE post_id = ?')
      .run('2026-01-01T00:00:00.000Z', older);
    ctx.sqlite
      .prepare('UPDATE favorites SET created_at = ? WHERE post_id = ?')
      .run('2026-03-01T00:00:00.000Z', newer);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/me/favorites',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(2);
    expect(list.json().posts.map((post: { id: number }) => post.id)).toEqual([newer, older]);
    expect(list.json().posts[0].thumbUrl).toBe(`/t/${newer}?v=2`);

    const { cookie: otherCookie } = await signUp(app, 'fan_three');
    const otherList = await app.inject({
      method: 'GET',
      url: '/api/v1/me/favorites',
      headers: { cookie: otherCookie },
    });
    expect(otherList.json().posts).toEqual([]);
  });
});

describe('pools', () => {
  it('lets staff curate an ordered pool and hides private pools from guests', async () => {
    const { app, ctx } = makeApp();
    const first = seedPost(ctx, { md5: 'e'.repeat(32), tags: ['one'] });
    const second = seedPost(ctx, { md5: 'f'.repeat(32), tags: ['two'] });

    const { cookie } = await signUp(app, 'curator');
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/pools',
      headers: { cookie },
      payload: { title: 'Nope' },
    });
    expect(denied.statusCode).toBe(403);
    makeStaff(ctx, 'curator');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/pools',
      headers: { cookie },
      payload: { title: '  Lake trip  ', description: 'Yuru Camp order', category: 'series' },
    });
    expect(created.statusCode).toBe(201);
    const pool = created.json().pool;
    expect(pool).toMatchObject({ title: 'Lake trip', category: 'series', isPublic: true });
    expect(pool.url).toMatch(new RegExp(`/pools/${pool.id}$`));

    const addedSecond = await app.inject({
      method: 'POST',
      url: `/api/v1/pools/${pool.id}/posts`,
      headers: { cookie },
      payload: { postId: second },
    });
    expect(addedSecond.statusCode).toBe(200);
    const addedFirst = await app.inject({
      method: 'POST',
      url: `/api/v1/pools/${pool.id}/posts`,
      headers: { cookie },
      payload: { postId: first, position: 0 },
    });
    expect(addedFirst.statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/pools/${pool.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().posts.map((post: { id: number }) => post.id)).toEqual([first, second]);
    expect(detail.json().pool.postCount).toBe(2);

    const list = await app.inject({ method: 'GET', url: '/api/v1/pools' });
    expect(list.json().total).toBe(1);
    expect(list.json().pools[0].title).toBe('Lake trip');

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/pools/${pool.id}`,
      headers: { cookie },
      payload: { isPublic: false },
    });
    const hidden = await app.inject({ method: 'GET', url: `/api/v1/pools/${pool.id}` });
    expect(hidden.statusCode).toBe(404);
    const staffView = await app.inject({
      method: 'GET',
      url: `/api/v1/pools/${pool.id}`,
      headers: { cookie },
    });
    expect(staffView.statusCode).toBe(200);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/pools/${pool.id}/posts/${second}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/pools/${pool.id}`, headers: { cookie } })).json()
        .posts.length,
    ).toBe(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/pools/${pool.id}`,
      headers: { cookie },
    });
    expect(deleted.statusCode).toBe(204);
  });
});

describe('parent and children', () => {
  it('links a version to its original and refuses cycles', async () => {
    const { app, ctx } = makeApp();
    const original = seedPost(ctx, { md5: '1'.repeat(32), tags: ['camp'] });
    const crop = seedPost(ctx, { md5: '2'.repeat(32), tags: ['camp'] });

    const { cookie } = await signUp(app, 'mod_one');
    makeStaff(ctx, 'mod_one');

    const linked = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${crop}/parent`,
      headers: { cookie },
      payload: { parentId: original },
    });
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toEqual({ postId: crop, parentId: original });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${original}` });
    expect(detail.json().parent).toBeNull();
    expect(detail.json().children.map((child: { id: number }) => child.id)).toEqual([crop]);

    const childDetail = await app.inject({ method: 'GET', url: `/api/v1/posts/${crop}` });
    expect(childDetail.json().parent.id).toBe(original);

    const cycle = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${original}/parent`,
      headers: { cookie },
      payload: { parentId: crop },
    });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().code).toBe('parent_cycle');

    const self = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${original}/parent`,
      headers: { cookie },
      payload: { parentId: original },
    });
    expect(self.statusCode).toBe(409);

    const cleared = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${crop}/parent`,
      headers: { cookie },
      payload: { parentId: null },
    });
    expect(cleared.json()).toEqual({ postId: crop, parentId: null });
  });

  it('rejects parent edits from ordinary users', async () => {
    const { app, ctx } = makeApp();
    const postId = seedPost(ctx, { md5: '3'.repeat(32), tags: ['camp'] });
    const { cookie } = await signUp(app, 'plain_user');
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/parent`,
      headers: { cookie },
      payload: { parentId: null },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('staff_required');
  });
});

describe('random post', () => {
  it('returns one post inside the requested rating mode', async () => {
    const { app, ctx } = makeApp();
    seedPost(ctx, { md5: '4'.repeat(32), tags: ['safe'], rating: 's' });
    seedPost(ctx, { md5: '5'.repeat(32), tags: ['explicit'], rating: 'e' });

    const safe = await app.inject({ method: 'GET', url: '/api/v1/posts/random?rating_mode=safe' });
    expect(safe.statusCode).toBe(200);
    expect(safe.json().post.rating).toBe('s');
    expect(safe.json().post.url).toMatch(/^\/i\/\d+$/);

    const adult = await app.inject({ method: 'GET', url: '/api/v1/posts/random?rating_mode=adult' });
    expect(adult.statusCode).toBe(200);
    expect(adult.json().post.rating).toBe('e');

    const empty = await app.inject({
      method: 'GET',
      url: '/api/v1/posts/random?tags=does_not_exist',
    });
    expect(empty.statusCode).toBe(404);
    expect(empty.json().code).toBe('no_posts');
  });
});
