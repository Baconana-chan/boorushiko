import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
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

async function samplePng(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 480, channels: 3, background: '#b83280' } })
    .png()
    .toBuffer();
}

function multipart(file: Buffer, fields: Record<string, string>) {
  const boundary = '----boorushiko-test';
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="art.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
  );
  chunks.push(file);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('uploader access', () => {
  it('gates uploads until a moderator approves an application', async () => {
    const { app, ctx } = makeApp();
    const member = await signUp(app, 'member');
    const moderator = await signUp(app, 'mod');
    makeStaff(ctx, 'mod', 'moderator');

    const png = await samplePng();
    const form = multipart(png, { tags: 'artist:someone, solo', rating: 's' });

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie: member.cookie, ...form.headers },
      payload: form.payload,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('uploader_required');

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/me/uploader',
      headers: { cookie: member.cookie },
    });
    expect(before.json()).toMatchObject({ approved: false, request: null });

    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/me/uploader-request',
      headers: { cookie: member.cookie },
      payload: { message: 'I draw traditional 2D art.' },
    });
    expect(applied.statusCode).toBe(201);
    expect(applied.json()).toMatchObject({
      approved: false,
      request: { message: 'I draw traditional 2D art.', status: 'pending' },
    });

    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/me/uploader-request',
      headers: { cookie: member.cookie },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('request_pending');

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/uploaders',
      headers: { cookie: moderator.cookie },
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().requests).toEqual([
      expect.objectContaining({ username: 'member', status: 'pending' }),
    ]);

    const overview = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/overview',
      headers: { cookie: moderator.cookie },
    });
    expect(overview.json().pendingUploaderRequests).toBe(1);

    const requestId = adminList.json().requests[0].id as number;
    const approved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/uploader-requests/${requestId}`,
      headers: { cookie: moderator.cookie },
      payload: { status: 'approved', note: 'welcome' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().request).toMatchObject({ status: 'approved', reviewer: 'mod' });

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/me/uploader',
      headers: { cookie: member.cookie },
    });
    expect(after.json()).toMatchObject({ approved: true, request: { status: 'approved' } });

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: member.cookie },
    });
    expect(me.json().user).toMatchObject({ username: 'member', canUpload: true });

    const form2 = multipart(png, {
      tags: 'artist:someone, character:flandre, solo',
      rating: 'q',
      sourceUrl: 'https://example.com/art/1',
    });
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: { cookie: member.cookie, ...form2.headers },
      payload: form2.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    const postId = uploaded.json().postId as number;

    const row = ctx.sqlite
      .prepare('SELECT uploaded_by AS uploadedBy, rating, status FROM posts WHERE id = ?')
      .get(postId) as { uploadedBy: number; rating: string; status: string };
    expect(row.uploadedBy).toBe(member.userId);
    expect(row.rating).toBe('q');
    expect(['pending', 'active']).toContain(row.status);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/me/uploads',
      headers: { cookie: member.cookie },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({
      total: 1,
      uploads: [
        {
          id: postId,
          status: expect.stringMatching(/pending|active/),
          tags: expect.arrayContaining([{ name: 'someone', category: 'artist' }]),
        },
      ],
    });

    // An uploader is still a regular member for staff-only routes.
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/uploaders',
      headers: { cookie: member.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('lets a rejected member apply again and supports revoking access', async () => {
    const { app, ctx } = makeApp();
    const member = await signUp(app, 'member');
    const moderator = await signUp(app, 'mod');
    makeStaff(ctx, 'mod', 'moderator');

    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/me/uploader-request',
      headers: { cookie: member.cookie },
      payload: { message: 'first attempt' },
    });
    const requestId = applied.json().request.id as number;

    const rejected = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/uploader-requests/${requestId}`,
      headers: { cookie: moderator.cookie },
      payload: { status: 'rejected', note: 'Add a gallery link.' },
    });
    expect(rejected.statusCode).toBe(200);

    const state = await app.inject({
      method: 'GET',
      url: '/api/v1/me/uploader',
      headers: { cookie: member.cookie },
    });
    expect(state.json()).toMatchObject({
      approved: false,
      request: { status: 'rejected', reviewNote: 'Add a gallery link.' },
    });

    const reapplied = await app.inject({
      method: 'POST',
      url: '/api/v1/me/uploader-request',
      headers: { cookie: member.cookie },
      payload: { message: 'https://example.com/gallery' },
    });
    expect(reapplied.statusCode).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/uploaders',
      headers: { cookie: moderator.cookie },
    });
    const secondId = list.json().requests[0].id as number;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/uploader-requests/${secondId}`,
      headers: { cookie: moderator.cookie },
      payload: { status: 'approved' },
    });

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/uploaders/${member.userId}`,
      headers: { cookie: moderator.cookie },
    });
    expect(revoked.statusCode).toBe(204);

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v1/me/uploader',
      headers: { cookie: member.cookie },
    });
    expect(afterRevoke.json().approved).toBe(false);
  });
});
