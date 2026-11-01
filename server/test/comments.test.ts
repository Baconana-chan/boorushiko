import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createTestContext, seedPost } from './helpers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp(overrides: Parameters<typeof createTestContext>[0] = {}) {
  const context = createTestContext({
    commentCooldownSeconds: 0,
    commentVoteCooldownSeconds: 0,
    commentVoteDailyLimit: 0,
    ...overrides,
  });
  const app = buildApp(context.ctx);
  apps.push(app);
  return { ...context, app };
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : (raw ?? '');
  return value.split(';')[0] ?? '';
}

async function signUp(app: FastifyInstance, username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, password: 'correct-horse' },
  });
  return cookieFrom(response);
}

function postComment(app: FastifyInstance, cookie: string, postId: number, body: unknown) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/posts/${postId}/comments`,
    headers: { cookie },
    payload: { body },
  });
}

describe('comments', () => {
  it('requires a session, blocks links and stores plain multiline text', async () => {
    const { app, ctx } = makeApp();
    const postId = seedPost(ctx, { md5: 'a'.repeat(32) });

    const anonymous = await postComment(app, '', postId, 'hello');
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe('auth_required');

    const cookie = await signUp(app, 'commenter');

    const scheme = await postComment(app, cookie, postId, 'look at https://example.com/art');
    expect(scheme.statusCode).toBe(400);
    expect(scheme.json().code).toBe('link_not_allowed');

    const bare = await postComment(app, cookie, postId, 'source: pixiv.net/123');
    expect(bare.statusCode).toBe(400);

    const created = await postComment(app, cookie, postId, 'Nice art!\r\nLove the shading.');
    expect(created.statusCode).toBe(201);
    expect(created.json().comment).toMatchObject({
      body: 'Nice art!\nLove the shading.',
      user: { username: 'commenter', role: 'user' },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}/comments`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1, hasMore: false });
    expect(list.json().comments[0].body).toBe('Nice art!\nLove the shading.');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/posts/${postId}` });
    expect(detail.json().commentCount).toBe(1);
  });

  it('lets authors delete their own comments but not other users comments', async () => {
    const { app, ctx } = makeApp();
    const postId = seedPost(ctx, { md5: 'b'.repeat(32) });
    const author = await signUp(app, 'author');
    const stranger = await signUp(app, 'stranger');

    const created = await postComment(app, author, postId, 'first!');
    const commentId = created.json().comment.id as number;

    const forbidden = await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${commentId}`,
      headers: { cookie: stranger },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().code).toBe('forbidden');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${commentId}`,
      headers: { cookie: author },
    });
    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}/comments`,
    });
    expect(list.json().total).toBe(0);
  });

  it('lets moderators remove any comment', async () => {
    const { app, ctx } = makeApp();
    const postId = seedPost(ctx, { md5: 'c'.repeat(32) });
    const author = await signUp(app, 'author2');
    const moderator = await signUp(app, 'moderator');
    ctx.sqlite.prepare("UPDATE users SET role = 'moderator' WHERE username = 'moderator'").run();

    const created = await postComment(app, author, postId, 'remove me');
    const commentId = created.json().comment.id as number;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/comments/${commentId}`,
      headers: { cookie: moderator },
    });
    expect(deleted.statusCode).toBe(204);
  });

  it('applies the per-user comment cooldown', async () => {
    const { app, ctx } = makeApp({ commentCooldownSeconds: 60 });
    const postId = seedPost(ctx, { md5: 'd'.repeat(32) });
    const cookie = await signUp(app, 'fast_typer');

    expect((await postComment(app, cookie, postId, 'one')).statusCode).toBe(201);

    const second = await postComment(app, cookie, postId, 'two');
    expect(second.statusCode).toBe(429);
    expect(second.json().code).toBe('slow_down');
    expect(second.json().retryAfterSeconds).toBeGreaterThan(0);
  });

  it('scores comments, hides them at the threshold and derives author karma', async () => {
    const { app, ctx } = makeApp({ commentHideScore: -2, commentHideMinVotes: 2 });
    const postId = seedPost(ctx, { md5: '1'.repeat(32) });
    const author = await signUp(app, 'artist_fan');
    const first = await signUp(app, 'first_voter');
    const second = await signUp(app, 'second_voter');
    const viewer = await signUp(app, 'viewer');

    const created = await postComment(app, author, postId, 'I like the palette.');
    const commentId = created.json().comment.id as number;
    expect(created.json().comment).toMatchObject({
      score: 0,
      voteCount: 0,
      hidden: false,
      myVote: 0,
      authorKarma: 0,
    });

    const selfVote = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentId}/vote`,
      headers: { cookie: author },
      payload: { value: 1 },
    });
    expect(selfVote.statusCode).toBe(403);
    expect(selfVote.json().code).toBe('self_vote');

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentId}/vote`,
      headers: { cookie: first },
      payload: { value: 2 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('invalid_vote');

    const downOne = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentId}/vote`,
      headers: { cookie: first },
      payload: { value: -1 },
    });
    expect(downOne.json().comment).toMatchObject({
      score: -1,
      voteCount: 1,
      hidden: false,
      myVote: -1,
      authorKarma: -1,
    });

    const downTwo = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentId}/vote`,
      headers: { cookie: second },
      payload: { value: -1 },
    });
    expect(downTwo.json().comment).toMatchObject({
      score: -2,
      voteCount: 2,
      hidden: true,
      authorKarma: -2,
    });

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentId}/vote`,
      headers: { cookie: first },
      payload: { value: -1 },
    });
    expect(duplicate.json().comment).toMatchObject({ score: -2, voteCount: 2 });

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}/comments`,
      headers: { cookie: viewer },
    });
    expect(list.json().comments[0]).toMatchObject({
      hidden: true,
      myVote: 0,
      authorKarma: -2,
    });

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: author },
    });
    expect(me.json().user.commentKarma).toBe(-2);

    const rescued = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentId}/vote`,
      headers: { cookie: first },
      payload: { value: 1 },
    });
    expect(rescued.json().comment).toMatchObject({
      score: 0,
      voteCount: 2,
      hidden: false,
      myVote: 1,
    });

    const removed = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentId}/vote`,
      headers: { cookie: first },
      payload: { value: 0 },
    });
    expect(removed.json().comment).toMatchObject({
      score: -1,
      voteCount: 1,
      hidden: false,
      myVote: 0,
    });
  });

  it('weights staff votes while keeping voteCount as distinct voters', async () => {
    const { app, ctx } = makeApp({
      commentHideScore: -3,
      commentHideMinVotes: 2,
      commentModVoteWeight: 3,
    });
    const postId = seedPost(ctx, { md5: '2'.repeat(32) });
    const author = await signUp(app, 'weighted_author');
    const moderator = await signUp(app, 'weighted_mod');
    const member = await signUp(app, 'weighted_member');
    ctx.sqlite.prepare("UPDATE users SET role = 'moderator' WHERE username = 'weighted_mod'").run();

    const created = await postComment(app, author, postId, 'A weighted opinion.');
    const commentId = created.json().comment.id as number;

    const staffVote = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentId}/vote`,
      headers: { cookie: moderator },
      payload: { value: -1 },
    });
    expect(staffVote.json().comment).toMatchObject({
      score: -3,
      voteCount: 1,
      hidden: false,
      authorKarma: -3,
    });

    const memberVote = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentId}/vote`,
      headers: { cookie: member },
      payload: { value: -1 },
    });
    expect(memberVote.json().comment).toMatchObject({
      score: -4,
      voteCount: 2,
      hidden: true,
      authorKarma: -4,
    });
  });

  it('caps daily vote actions but always allows removing a vote', async () => {
    const { app, ctx } = makeApp({ commentVoteDailyLimit: 2 });
    const postId = seedPost(ctx, { md5: '3'.repeat(32) });
    const author = await signUp(app, 'quota_author');
    const voter = await signUp(app, 'quota_voter');

    const commentIds: number[] = [];
    for (const body of ['one', 'two', 'three']) {
      const created = await postComment(app, author, postId, body);
      commentIds.push(created.json().comment.id as number);
    }

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentIds[0]}/vote`,
      headers: { cookie: voter },
      payload: { value: 1 },
    });
    expect(first.statusCode).toBe(200);

    // Re-sending the same vote is a no-op and must not spend quota.
    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentIds[0]}/vote`,
      headers: { cookie: voter },
      payload: { value: 1 },
    });
    expect(duplicate.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentIds[1]}/vote`,
      headers: { cookie: voter },
      payload: { value: 1 },
    });
    expect(second.statusCode).toBe(200);

    const limited = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentIds[2]}/vote`,
      headers: { cookie: voter },
      payload: { value: 1 },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('vote_limit');
    expect(limited.json().retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.headers['retry-after']).toBeDefined();

    // Removing an existing vote is not a new vote and stays available.
    const removed = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentIds[0]}/vote`,
      headers: { cookie: voter },
      payload: { value: 0 },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().comment.myVote).toBe(0);

    const stillLimited = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentIds[2]}/vote`,
      headers: { cookie: voter },
      payload: { value: 1 },
    });
    expect(stillLimited.statusCode).toBe(429);

    // Once the rolling window passes, voting works again.
    const voterRow = ctx.sqlite
      .prepare("SELECT id FROM users WHERE username = 'quota_voter'")
      .get() as { id: number };
    ctx.sqlite
      .prepare('UPDATE comment_vote_actions SET created_at = ? WHERE user_id = ?')
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), voterRow.id);
    const afterWindow = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${commentIds[2]}/vote`,
      headers: { cookie: voter },
      payload: { value: 1 },
    });
    expect(afterWindow.statusCode).toBe(200);
  });

  it('rate-limits rapid vote changes but lets a user undo a vote', async () => {
    const { app, ctx } = makeApp({ commentVoteCooldownSeconds: 60 });
    const postId = seedPost(ctx, { md5: '4'.repeat(32) });
    const author = await signUp(app, 'cooldown_author');
    const voter = await signUp(app, 'cooldown_voter');

    const firstComment = await postComment(app, author, postId, 'first');
    const secondComment = await postComment(app, author, postId, 'second');
    const firstId = firstComment.json().comment.id as number;
    const secondId = secondComment.json().comment.id as number;

    const voted = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${firstId}/vote`,
      headers: { cookie: voter },
      payload: { value: 1 },
    });
    expect(voted.statusCode).toBe(200);

    const rapid = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${secondId}/vote`,
      headers: { cookie: voter },
      payload: { value: 1 },
    });
    expect(rapid.statusCode).toBe(429);
    expect(rapid.json().code).toBe('vote_slow_down');
    expect(rapid.json().retryAfterSeconds).toBeGreaterThan(0);

    const undone = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${firstId}/vote`,
      headers: { cookie: voter },
      payload: { value: 0 },
    });
    expect(undone.statusCode).toBe(200);
  });

  it('blocks reciprocal downvotes until the first one is removed', async () => {
    const { app, ctx } = makeApp();
    const postId = seedPost(ctx, { md5: '5'.repeat(32) });
    const alice = await signUp(app, 'alice');
    const bob = await signUp(app, 'bob');

    const aliceComment = await postComment(app, alice, postId, 'alice here');
    const bobComment = await postComment(app, bob, postId, 'bob here');
    const aliceCommentId = aliceComment.json().comment.id as number;
    const bobCommentId = bobComment.json().comment.id as number;

    const aliceDown = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${bobCommentId}/vote`,
      headers: { cookie: alice },
      payload: { value: -1 },
    });
    expect(aliceDown.statusCode).toBe(200);

    const bobDown = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${aliceCommentId}/vote`,
      headers: { cookie: bob },
      payload: { value: -1 },
    });
    expect(bobDown.statusCode).toBe(409);
    expect(bobDown.json().code).toBe('mutual_downvote');

    // Replies are not blocked, only another downvote.
    const bobUp = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${aliceCommentId}/vote`,
      headers: { cookie: bob },
      payload: { value: 1 },
    });
    expect(bobUp.statusCode).toBe(200);

    const aliceUndo = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${bobCommentId}/vote`,
      headers: { cookie: alice },
      payload: { value: 0 },
    });
    expect(aliceUndo.statusCode).toBe(200);

    const bobDownAgain = await app.inject({
      method: 'POST',
      url: `/api/v1/comments/${aliceCommentId}/vote`,
      headers: { cookie: bob },
      payload: { value: -1 },
    });
    expect(bobDownAgain.statusCode).toBe(200);
  });

  it('paginates from the end and rejects comments on pending posts', async () => {
    const { app, ctx } = makeApp();
    const postId = seedPost(ctx, { md5: 'e'.repeat(32) });
    const cookie = await signUp(app, 'pager');

    await postComment(app, cookie, postId, 'one');
    await postComment(app, cookie, postId, 'two');
    await postComment(app, cookie, postId, 'three');

    const lastTwo = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}/comments?limit=2`,
    });
    expect(lastTwo.json().comments.map((comment: { body: string }) => comment.body)).toEqual([
      'two',
      'three',
    ]);
    expect(lastTwo.json()).toMatchObject({ hasMore: true, total: 3 });

    const firstId = lastTwo.json().comments[0].id as number;
    const earlier = await app.inject({
      method: 'GET',
      url: `/api/v1/posts/${postId}/comments?limit=2&before=${firstId}`,
    });
    expect(earlier.json().comments.map((comment: { body: string }) => comment.body)).toEqual([
      'one',
    ]);
    expect(earlier.json().hasMore).toBe(false);

    const empty = await postComment(app, cookie, postId, '   ');
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe('comment_empty');

    const pendingPost = seedPost(ctx, { md5: 'f'.repeat(32), status: 'pending' });
    const pending = await postComment(app, cookie, pendingPost, 'hello');
    expect(pending.statusCode).toBe(404);
  });
});
