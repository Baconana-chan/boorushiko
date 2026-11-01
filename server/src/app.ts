import { randomUUID } from 'node:crypto';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { currentUser } from './auth.js';
import type { EngineContext } from './context.js';
import { applyCors } from './cors.js';
import { healthSnapshot, readySnapshot } from './health.js';
import { openApiDocument } from './openapi.js';
import { processJobs } from './jobs.js';
import { postLinks, THUMB_VERSION } from './links.js';
import { findRelatedPosts } from './related.js';
import { loadOgPost, ogHtml, rssFeed } from './feed.js';
import { isSameOriginRequest } from './origin.js';
import { DnpArtistError } from './policy.js';
import { RateLimiter, rateLimited } from './rate-limit.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCollectionRoutes } from './routes/collections.js';
import { createRemotePost, RemotePostError } from './remote.js';
import { createRemoteThumbService } from './remote-thumbs.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerUploadRoutes } from './routes/uploads.js';
import {
  getPost,
  parseSearch,
  queryPosts,
  searchTags,
  SearchError,
  type Rating,
} from './search.js';
import { securityTxt } from './security.js';
import { isSensitiveTag } from './sensitive-tags.js';
import { pagesSitemap, postsSitemap, robotsTxt, sitemapIndex } from './sitemap.js';
import { createPostFromStaged } from './upload.js';
import { readUploadRequest, UploadRequestError } from './upload-request.js';

function intParam(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

/** `undefined` when absent, `null` when malformed: an id cursor must be explicit. */
function cursorParam(value: string | undefined): number | undefined | null {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function notFound(reply: FastifyReply, message = 'not found') {
  return reply.code(404).send({ error: message });
}

function sendXml(reply: FastifyReply, xml: string) {
  return reply
    .header('Content-Type', 'application/xml; charset=utf-8')
    .header('Cache-Control', 'public, max-age=3600')
    .send(xml);
}

const RATING_MODES: Record<string, Rating[]> = {
  safe: ['s'],
  mixed: ['s', 'q'],
  // Adult is an explicit-only view, not "everything including explicit".
  adult: ['e'],
};

function visibleRatings(params: Record<string, string | undefined>): Rating[] | null {
  if (params['rating_mode'] !== undefined) return RATING_MODES[params['rating_mode']] ?? null;
  // Deprecated binary flag kept for parser/API clients.
  return params['show_explicit'] === '1' ? ['s', 'q', 'e'] : ['s', 'q'];
}

export function buildApp(ctx: EngineContext): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: ctx.config.trustProxy,
    // JSON/form bodies are small; uploads go through multipart with their own cap.
    bodyLimit: ctx.config.bodyLimitBytes,
    requestTimeout: ctx.config.requestTimeoutMs,
    keepAliveTimeout: 72_000,
    routerOptions: { maxParamLength: 200 },
    // Correlation id for every request; the same id lands in the logs and the
    // X-Request-Id response header that clients can quote in reports.
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      const incoming = Array.isArray(header) ? header[0] : header;
      return incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
  });
  // Node-level guards: bounded header count and a short window to finish headers.
  app.server.headersTimeout = ctx.config.headersTimeoutMs;
  app.server.maxHeadersCount = 100;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    // Cookie-authenticated mutations must originate from our own pages.
    if (!isSameOriginRequest(request, ctx.config)) {
      return reply.code(403).send({ error: 'cross-origin request rejected', code: 'cross_origin' });
    }
    // Public read endpoints are readable from other origins; preflights end here.
    if (applyCors(request, reply, ctx.config)) return reply;
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!ctx.config.logRequests) return;
    ctx.log.info('request', {
      requestId: request.id,
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      ip: request.ip,
    });
  });

  app.addHook('onError', async (request, reply, error) => {
    ctx.log.error('request error', {
      requestId: request.id,
      method: request.method,
      url: request.url,
      status: error.statusCode ?? reply.statusCode ?? 500,
      err: error,
    });
  });

  const limiter = new RateLimiter(ctx.config.rateLimitEnabled);
  app.register(multipart, {
    limits: { fileSize: ctx.config.maxUploadBytes, files: 1, fields: 20 },
  });
  registerAuthRoutes(app, ctx, limiter);
  registerCommentRoutes(app, ctx, limiter);
  registerCollectionRoutes(app, ctx, limiter);
  registerAdminRoutes(app, ctx, limiter);
  registerNotificationRoutes(app, ctx);
  registerStatsRoutes(app, ctx);
  registerUploadRoutes(app, ctx, limiter);
  const remoteThumbs = createRemoteThumbService(ctx);

  app.get('/api/v1/openapi.json', async (_request, reply) => {
    return reply
      .header('Cache-Control', 'public, max-age=3600')
      .send(openApiDocument(ctx.config.publicBaseUrl));
  });

  app.get('/healthz', async (_request, reply) => {
    const health = await healthSnapshot(ctx);
    return reply.code(health.ok ? 200 : 503).send(health);
  });

  app.get('/readyz', async (_request, reply) => {
    const ready = await readySnapshot(ctx);
    return reply.code(ready.ok ? 200 : 503).send(ready);
  });

  app.get('/robots.txt', async (_request, reply) => {
    return reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(robotsTxt(ctx.config.publicBaseUrl));
  });

  app.get('/.well-known/security.txt', async (_request, reply) => {
    return reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .send(
        securityTxt(
          ctx.config.publicBaseUrl,
          ctx.config.securityContact,
          ctx.config.securityExpires,
        ),
      );
  });

  app.get('/sitemap.xml', async (_request, reply) => {
    return sendXml(reply, sitemapIndex(ctx.sqlite, ctx.config.publicBaseUrl));
  });

  app.get('/sitemap-pages.xml', async (_request, reply) => {
    return sendXml(reply, pagesSitemap(ctx.config.publicBaseUrl));
  });

  app.get('/sitemap-posts-:page.xml', async (request, reply) => {
    const page = intParam((request.params as { page: string }).page, 0);
    const xml = postsSitemap(ctx.sqlite, ctx.config.publicBaseUrl, page);
    if (!xml) return notFound(reply, 'sitemap page not found');
    return sendXml(reply, xml);
  });

  app.get('/feed.xml', async (_request, reply) => {
    const xml = rssFeed(ctx.sqlite, ctx.config.publicBaseUrl, {
      sensitiveTags: ctx.config.sensitiveTags,
    });
    return reply
      .header('Content-Type', 'application/rss+xml; charset=utf-8')
      .header('Cache-Control', 'public, max-age=600')
      .send(xml);
  });

  // The Angular route is /post/:id; Caddy sends crawlers here for the meta tags
  // and everyone else to index.html. Explicit or sensitive-tagged posts get no
  // OG image, a generic description and noindex.
  app.get('/post/:id', async (request, reply) => {
    const id = intParam((request.params as { id: string }).id, 0);
    if (id <= 0) return reply.code(404).send(ogHtml(null, ctx.config.publicBaseUrl));
    const post = loadOgPost(ctx.sqlite, id);
    const sensitive = Boolean(
      post?.tags.some((tag) => isSensitiveTag(tag.name, ctx.config.sensitiveTags)),
    );
    return reply
      .code(post ? 200 : 404)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .send(ogHtml(post, ctx.config.publicBaseUrl, 'Boorushiko', sensitive));
  });

  app.post('/api/v1/posts', async (request, reply) => {
    // Bot endpoint: unlike /api/v1/uploads it never accepts a user session.
    if (!ctx.config.uploadToken || request.headers['x-upload-token'] !== ctx.config.uploadToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    let parsed;
    try {
      parsed = await readUploadRequest(request, {
        dir: ctx.config.stagingDir,
        maxBytes: ctx.config.maxUploadBytes,
      });
    } catch (error) {
      if (error instanceof UploadRequestError) {
        return reply.code(error.status).send({ error: error.message, code: error.code });
      }
      throw error;
    }

    try {
      const result = await createPostFromStaged(ctx, parsed.staged, {
        tags: parsed.fields.tags,
        rating: parsed.fields.rating,
        sourceUrl: parsed.fields.sourceUrl,
        filename: parsed.filename,
      });
      // Kick the queue once so a single upload usually becomes visible immediately.
      void processJobs(ctx).catch(() => undefined);
      // Never expose staging paths: they are internal and would leak the server layout.
      return reply.code(result.duplicate ? 200 : 201).send({
        postId: result.postId,
        duplicate: result.duplicate,
        status: result.status,
        jobs: result.jobs,
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      const status = name === 'DnpArtistError' ? 403 : name === 'UnsupportedMediaError' ? 415 : 400;
      return reply.code(status).send({
        error: error instanceof Error ? error.message : 'cannot create post',
        ...(error instanceof DnpArtistError ? { code: 'dnp_artist' } : {}),
      });
    }
  });

  app.post('/api/v1/posts/remote', async (request, reply) => {
    if (!ctx.config.uploadToken || request.headers['x-upload-token'] !== ctx.config.uploadToken) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    try {
      const result = createRemotePost(
        ctx,
        (request.body ?? {}) as Parameters<typeof createRemotePost>[1],
      );
      return reply.code(result.duplicate ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof RemotePostError) {
        const status =
          error.code === 'dnp_artist' ? 403 : error.code === 'unsupported_media' ? 415 : 400;
        return reply.code(status).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.get('/api/v1/posts', async (request, reply) => {
    const limited = rateLimited(limiter, request, reply, 'apiPosts');
    if (limited) return limited;

    const params = request.query as Record<string, string | undefined>;
    const allowed = visibleRatings(params);
    if (!allowed) {
      return reply.code(400).send({ error: 'rating_mode must be safe, mixed or adult' });
    }
    try {
      const search = parseSearch(params.tags ?? '');
      const hidden = (['s', 'q', 'e'] as Rating[]).filter((rating) => !allowed.includes(rating));
      search.excludeRatings = [...new Set([...search.excludeRatings, ...hidden])];

      const limit = Math.min(Math.max(intParam(params.limit, 20), 1), 100);
      const page = Math.max(intParam(params.page, 1), 1);
      const afterId = cursorParam(params['after_id']);
      const beforeId = cursorParam(params['before_id']);
      if (afterId === null || beforeId === null) {
        return reply.code(400).send({
          error: 'after_id and before_id must be post ids',
          code: 'invalid_cursor',
        });
      }
      if (afterId !== undefined && beforeId !== undefined) {
        return reply.code(400).send({
          error: 'use either after_id or before_id, not both',
          code: 'invalid_cursor',
        });
      }
      const cursorMode = afterId !== undefined || beforeId !== undefined;

      const result = queryPosts(ctx.sqlite, search, {
        limit,
        // A keyset cursor always starts at the beginning; a page offset would
        // make it skip or repeat posts while new uploads arrive.
        offset: cursorMode ? 0 : (page - 1) * limit,
        includeSensitive: params['include_sensitive'] !== '0',
        sensitiveTags: ctx.config.sensitiveTags,
        ...(afterId !== undefined ? { afterId } : {}),
        ...(beforeId !== undefined ? { beforeId } : {}),
      });

      const baseUrl = ctx.config.publicBaseUrl.replace(/\/+$/, '');
      const posts = result.posts.map((post) => ({ ...post, ...postLinks(post.id, baseUrl) }));

      return {
        page: cursorMode ? 1 : page,
        limit,
        hasMore: result.hasMore,
        baseUrl,
        ...(cursorMode
          ? { nextCursor: posts.length > 0 ? posts[posts.length - 1]!.id : null }
          : {}),
        posts,
      };
    } catch (error) {
      if (error instanceof SearchError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/v1/posts/random', async (request, reply) => {
    const limited = rateLimited(limiter, request, reply, 'apiPosts');
    if (limited) return limited;

    const params = request.query as Record<string, string | undefined>;
    const allowed = visibleRatings(params);
    if (!allowed) {
      return reply.code(400).send({ error: 'rating_mode must be safe, mixed or adult' });
    }
    try {
      const search = parseSearch(params.tags ?? '');
      const hidden = (['s', 'q', 'e'] as Rating[]).filter((rating) => !allowed.includes(rating));
      search.excludeRatings = [...new Set([...search.excludeRatings, ...hidden])];
      search.order = 'random';

      const result = queryPosts(ctx.sqlite, search, {
        limit: 1,
        offset: 0,
        includeSensitive: params['include_sensitive'] !== '0',
        sensitiveTags: ctx.config.sensitiveTags,
      });
      const post = result.posts[0];
      if (!post) {
        return reply.code(404).send({ error: 'no posts match this query', code: 'no_posts' });
      }
      const baseUrl = ctx.config.publicBaseUrl.replace(/\/+$/, '');
      return reply
        .header('Cache-Control', 'no-store')
        .send({ post: { ...post, ...postLinks(post.id, baseUrl) } });
    } catch (error) {
      if (error instanceof SearchError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/v1/posts/:id', async (request, reply) => {
    const limited = rateLimited(limiter, request, reply, 'apiPosts');
    if (limited) return limited;

    const id = intParam((request.params as { id: string }).id, 0);
    if (id <= 0) return notFound(reply);
    const post = getPost(ctx.sqlite, id);
    if (!post) return notFound(reply);

    const query = request.query as Record<string, string | undefined>;
    if (
      query['include_sensitive'] === '0' &&
      post.tags.some((tag) => isSensitiveTag(tag.name, ctx.config.sensitiveTags))
    ) {
      return reply.code(403).send({ error: 'sensitive content hidden', code: 'sensitive_hidden' });
    }

    const sources = ctx.sqlite
      .prepare(
        `SELECT host, url, role, format, status, priority FROM post_sources
         WHERE post_id = ? ORDER BY priority ASC, id ASC`,
      )
      .all(id);
    const variants = ctx.sqlite
      .prepare(
        'SELECT kind, url, width, height, bytes, format FROM post_variants WHERE post_id = ?',
      )
      .all(id);
    const origins = ctx.sqlite
      .prepare(
        `SELECT provider, page_url AS pageUrl, file_url AS fileUrl, preview_url AS previewUrl, status
         FROM post_origins WHERE post_id = ?`,
      )
      .all(id);
    const commentCount = ctx.sqlite
      .prepare('SELECT COUNT(*) AS count FROM comments WHERE post_id = ?')
      .get(id) as { count: number };

    const baseUrl = ctx.config.publicBaseUrl.replace(/\/+$/, '');
    const parentRow = ctx.sqlite
      .prepare('SELECT parent_id AS parentId FROM posts WHERE id = ?')
      .get(id) as { parentId: number | null } | undefined;
    const parentId = parentRow?.parentId ?? null;
    const children = (
      ctx.sqlite
        .prepare("SELECT id FROM posts WHERE parent_id = ? AND status = 'active' ORDER BY id")
        .all(id) as Array<{ id: number }>
    ).map((row) => ({ id: row.id, ...postLinks(row.id, baseUrl) }));
    const viewer = currentUser(ctx.sqlite, request);
    const favoriteCount = ctx.sqlite
      .prepare('SELECT COUNT(*) AS count FROM favorites WHERE post_id = ?')
      .get(id) as { count: number };
    const favorited = viewer
      ? Boolean(
          ctx.sqlite
            .prepare('SELECT 1 AS yes FROM favorites WHERE post_id = ? AND user_id = ?')
            .get(id, viewer.id),
        )
      : false;

    return {
      ...post,
      ...postLinks(id, baseUrl),
      baseUrl,
      sources,
      variants,
      origins,
      commentCount: commentCount.count,
      parent: parentId ? { id: parentId, ...postLinks(parentId, baseUrl) } : null,
      children,
      favorited,
      favoriteCount: favoriteCount.count,
    };
  });

  app.get('/api/v1/posts/:id/related', async (request, reply) => {
    const limited = rateLimited(limiter, request, reply, 'apiPosts');
    if (limited) return limited;

    const id = intParam((request.params as { id: string }).id, 0);
    if (id <= 0) return notFound(reply);
    const post = getPost(ctx.sqlite, id);
    if (!post) return notFound(reply);

    const params = request.query as Record<string, string | undefined>;
    const allowed = visibleRatings(params);
    if (!allowed) {
      return reply.code(400).send({ error: 'rating_mode must be safe, mixed or adult' });
    }

    const includeSensitive = params['include_sensitive'] !== '0';
    if (
      !includeSensitive &&
      post.tags.some((tag) => isSensitiveTag(tag.name, ctx.config.sensitiveTags))
    ) {
      return reply.code(403).send({ error: 'sensitive content hidden', code: 'sensitive_hidden' });
    }

    const limit = Math.min(Math.max(intParam(params.limit, 12), 1), 50);
    const related = findRelatedPosts(ctx.sqlite, id, {
      limit,
      ratings: allowed,
      includeSensitive,
      sensitiveTags: ctx.config.sensitiveTags,
    });

    const baseUrl = ctx.config.publicBaseUrl.replace(/\/+$/, '');
    return reply.header('Cache-Control', 'public, max-age=300').send({
      postId: id,
      limit,
      seedTags: related.seedTags,
      posts: related.posts.map((entry) => ({ ...entry, ...postLinks(entry.id, baseUrl) })),
    });
  });

  app.get('/api/v1/tags', async (request) => {
    const params = request.query as Record<string, string | undefined>;
    return { tags: searchTags(ctx.sqlite, params.search ?? '', intParam(params.limit, 20)) };
  });

  app.get('/i/:id', async (request, reply) => {
    const id = intParam((request.params as { id: string }).id, 0);
    if (id <= 0) return notFound(reply);

    const post = ctx.sqlite
      .prepare('SELECT storage_kind AS storageKind, status FROM posts WHERE id = ?')
      .get(id) as { storageKind: string; status: string } | undefined;
    if (!post || post.status === 'deleted') return notFound(reply);

    let target: string | undefined;
    if (post.storageKind === 'remote') {
      const origin = ctx.sqlite
        .prepare(`SELECT file_url AS fileUrl FROM post_origins WHERE post_id = ? AND status = 'ok'`)
        .get(id) as { fileUrl: string } | undefined;
      target = origin?.fileUrl;
    } else {
      const source = ctx.sqlite
        .prepare(
          `SELECT url FROM post_sources
           WHERE post_id = ? AND status = 'ok'
           ORDER BY priority ASC, id ASC LIMIT 1`,
        )
        .get(id) as { url: string } | undefined;
      target = source?.url;
    }

    if (!target) return notFound(reply, 'no live source');
    return reply.header('Cache-Control', 'public, max-age=60').redirect(target, 302);
  });

  app.get('/t/:id', async (request, reply) => {
    const id = intParam((request.params as { id: string }).id, 0);
    if (id <= 0) return notFound(reply);

    const post = ctx.sqlite
      .prepare('SELECT storage_kind AS storageKind, status FROM posts WHERE id = ?')
      .get(id) as { storageKind: string; status: string } | undefined;
    if (!post || post.status === 'deleted') return notFound(reply);

    if (post.storageKind === 'remote') {
      const thumb = await remoteThumbs.get(id);
      if (request.headers['if-none-match'] === thumb.etag) {
        return reply
          .header('ETag', thumb.etag)
          .header('Cache-Control', thumb.cacheable ? 'public, max-age=86400' : 'public, max-age=60')
          .code(304)
          .send();
      }
      return reply
        .header('Content-Type', thumb.contentType)
        .header('ETag', thumb.etag)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', thumb.cacheable ? 'public, max-age=86400' : 'public, max-age=60')
        .send(thumb.buffer);
    }

    const thumb = ctx.sqlite
      .prepare(
        `SELECT url FROM post_variants WHERE post_id = ? AND kind = 'thumb300' AND url IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as { url: string } | undefined;
    if (!thumb) return notFound(reply, 'no thumbnail');
    return reply.header('Cache-Control', 'public, max-age=300').redirect(thumb.url, 302);
  });

  return app;
}
