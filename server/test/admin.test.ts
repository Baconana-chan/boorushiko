import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { flagsFromText } from '../src/policy.js';
import { createTestContext, seedPost } from './helpers.js';

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

async function signUp(app: FastifyInstance, username: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password: 'correct-horse' },
  });
  return { cookie: cookieFrom(response), userId: response.json().user.id as number };
}

function makeStaff(
  ctx: ReturnType<typeof createTestContext>['ctx'],
  username: string,
  role: string,
) {
  ctx.sqlite
    .prepare('UPDATE users SET role = ? WHERE username_lower = ?')
    .run(role, username.toLowerCase());
}

describe('admin moderation', () => {
  it('requires a staff session and exposes queue counts', async () => {
    const { app, ctx } = makeApp();
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/admin/overview' });
    expect(anonymous.statusCode).toBe(401);

    const member = await signUp(app, 'member');
    const memberView = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { cookie: member.cookie },
    });
    expect(memberView.statusCode).toBe(403);

    const moderator = await signUp(app, 'moderator');
    makeStaff(ctx, 'moderator', 'moderator');
    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { cookie: moderator.cookie },
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ posts: { pending: 0 }, openReports: 0, dnp: 0 });
  });

  it('hides a post with a reason, writes audit and notifies the uploader', async () => {
    const { app, ctx } = makeApp();
    const uploader = await signUp(app, 'uploader');
    const moderator = await signUp(app, 'mod');
    makeStaff(ctx, 'mod', 'moderator');
    const postId = seedPost(ctx, {
      md5: 'a1'.repeat(16),
      status: 'pending',
      uploadedBy: uploader.userId,
      policyFlags: ['ai_metadata'],
    });

    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { cookie: moderator.cookie },
    });
    expect(overview.json()).toMatchObject({ posts: { pending: 1 }, flaggedPending: 1 });

    const queue = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/queue?status=pending',
      headers: { cookie: moderator.cookie },
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().posts[0]).toMatchObject({
      id: postId,
      status: 'pending',
      policyFlags: ['ai_metadata'],
    });

    const rejected = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/posts/${postId}`,
      headers: { cookie: moderator.cookie },
      payload: { status: 'hidden', reason: 'ai', note: 'prompt metadata found' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().post).toMatchObject({
      status: 'hidden',
      rejectionReason: 'ai',
      moderationNote: 'prompt metadata found',
    });

    const audit = ctx.sqlite
      .prepare('SELECT action, reason FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as { action: string; reason: string };
    expect(audit).toEqual({ action: 'post.reject', reason: 'ai' });

    const notification = ctx.sqlite
      .prepare('SELECT user_id AS userId, kind, post_id AS postId FROM notifications')
      .get() as { userId: number; kind: string; postId: number };
    expect(notification).toEqual({ userId: uploader.userId, kind: 'post_hidden', postId });

    const restored = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/posts/${postId}`,
      headers: { cookie: moderator.cookie },
      payload: { status: 'active' },
    });
    expect(restored.json().post).toMatchObject({
      status: 'active',
      rejectionReason: null,
    });
  });

  it('collects reports, blocks duplicate open reports and resolves with a hide', async () => {
    const { app, ctx } = makeApp();
    const reporter = await signUp(app, 'reporter');
    const moderator = await signUp(app, 'report_mod');
    makeStaff(ctx, 'report_mod', 'moderator');
    const postId = seedPost(ctx, { md5: 'b1'.repeat(16), status: 'active' });

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/reports`,
      headers: { cookie: reporter.cookie },
      payload: { reason: 'ai', body: 'This looks generated.' },
    });
    expect(created.statusCode).toBe(201);
    const reportId = created.json().report.id as number;

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/posts/${postId}/reports`,
      headers: { cookie: reporter.cookie },
      payload: { reason: 'ai' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('already_reported');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/reports?status=open',
      headers: { cookie: moderator.cookie },
    });
    expect(list.json().reports).toHaveLength(1);
    expect(list.json().reports[0]).toMatchObject({ id: reportId, postId, reporter: 'reporter' });

    const resolved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/reports/${reportId}`,
      headers: { cookie: moderator.cookie },
      payload: { status: 'resolved', hidePost: true, note: 'confirmed by metadata' },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().report).toMatchObject({ status: 'resolved', resolvedBy: 'report_mod' });

    const post = ctx.sqlite
      .prepare('SELECT status, rejection_reason AS reason FROM posts WHERE id = ?')
      .get(postId) as { status: string; reason: string };
    expect(post).toEqual({ status: 'hidden', reason: 'ai' });

    const actions = ctx.sqlite.prepare('SELECT action FROM audit_log ORDER BY id').all() as Array<{
      action: string;
    }>;
    expect(actions.map((row) => row.action)).toEqual([
      'report.create',
      'post.reject',
      'report.resolve',
    ]);
  });

  it('manages the DNP list and blocks matching remote imports', async () => {
    const { app, ctx } = makeApp({ uploadToken: 'secret' });
    const moderator = await signUp(app, 'dnp_mod');
    makeStaff(ctx, 'dnp_mod', 'admin');

    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/dnp',
      headers: { cookie: moderator.cookie },
      payload: {
        name: 'Artist Name',
        sourcePattern: 'pixiv.net/users/42',
        note: 'requested removal',
      },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().entry).toMatchObject({
      name: 'artist_name',
      sourcePattern: 'pixiv.net/users/42',
    });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/dnp',
      headers: { cookie: moderator.cookie },
      payload: { name: 'artist_name' },
    });
    expect(duplicate.statusCode).toBe(409);

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/posts/remote',
      headers: { 'x-upload-token': 'secret' },
      payload: {
        provider: 'danbooru',
        originId: 'dnp-1',
        fileUrl: 'https://cdn.example/art.png',
        sourceUrl: 'https://www.pixiv.net/artworks/1',
        mime: 'image/png',
        tags: 'artist:artist_name, solo',
      },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('dnp_artist');

    const bySource = await app.inject({
      method: 'POST',
      url: '/api/v1/posts/remote',
      headers: { 'x-upload-token': 'secret' },
      payload: {
        provider: 'danbooru',
        originId: 'dnp-2',
        fileUrl: 'https://cdn.example/other.png',
        sourceUrl: 'https://www.pixiv.net/users/42/artworks',
        mime: 'image/png',
        tags: 'solo',
      },
    });
    expect(bySource.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/dnp',
      headers: { cookie: moderator.cookie },
    });
    const entryId = list.json().entries[0].id as number;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/dnp/${entryId}`,
      headers: { cookie: moderator.cookie },
    });
    expect(removed.statusCode).toBe(204);
  });

  it('recognizes AI and 3D metadata as review signals', () => {
    expect(flagsFromText('parameters: masterpiece, best quality', 'metadata')).toEqual([
      'ai_metadata',
    ]);
    expect(flagsFromText('ComfyUI_00012_.png', 'filename')).toEqual(['ai_filename']);
    expect(flagsFromText('Software: Blender 4.2', 'metadata')).toEqual(['3d_metadata']);
    expect(flagsFromText('mmd_stage_01.png', 'filename')).toEqual(['3d_filename']);
    expect(flagsFromText('solo, flandre', 'metadata')).toEqual([]);
  });

  it('returns notifications for the uploader and marks them read', async () => {
    const { app, ctx } = makeApp();
    const uploader = await signUp(app, 'notify_user');
    const postId = seedPost(ctx, { md5: 'c1'.repeat(16), uploadedBy: uploader.userId });
    ctx.sqlite
      .prepare(
        `INSERT INTO notifications (user_id, kind, post_id, body, created_at)
         VALUES (?, 'post_hidden', ?, 'hidden', ?)`,
      )
      .run(uploader.userId, postId, new Date().toISOString());

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/me/notifications',
      headers: { cookie: uploader.cookie },
    });
    expect(list.json()).toMatchObject({ unread: 1 });
    expect(list.json().notifications[0]).toMatchObject({ kind: 'post_hidden', postId });

    const read = await app.inject({
      method: 'POST',
      url: '/api/v1/me/notifications/read',
      headers: { cookie: uploader.cookie },
    });
    expect(read.json()).toEqual({ unread: 0 });
  });
});
