import type { FastifyInstance } from 'fastify';
import type { Sqlite } from '../db.js';
import type { EngineContext } from '../context.js';

type StatsRow = Record<string, unknown>;

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readArchiveStats(sqlite: Sqlite) {
  const posts = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN status = 'active' THEN 1 END) AS active,
         COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
         COUNT(CASE WHEN status = 'hidden' THEN 1 END) AS hidden,
         COUNT(CASE WHEN status = 'deleted' THEN 1 END) AS deleted,
         COUNT(CASE WHEN status <> 'deleted' AND mime LIKE 'image/%' THEN 1 END) AS images,
         COUNT(CASE WHEN status <> 'deleted' AND mime = 'image/gif' THEN 1 END) AS animated,
         COUNT(CASE WHEN status <> 'deleted' AND mime LIKE 'video/%' THEN 1 END) AS videos,
         COUNT(CASE WHEN status <> 'deleted' AND rating = 's' THEN 1 END) AS general,
         COUNT(CASE WHEN status <> 'deleted' AND rating = 'q' THEN 1 END) AS sensitive,
         COUNT(CASE WHEN status <> 'deleted' AND rating = 'e' THEN 1 END) AS explicit,
         COUNT(CASE WHEN status <> 'deleted' AND storage_kind = 'hosted' THEN 1 END) AS hosted,
         COUNT(CASE WHEN status <> 'deleted' AND storage_kind = 'remote' THEN 1 END) AS remote,
         MIN(CASE WHEN status <> 'deleted' THEN created_at END) AS oldest,
         MAX(CASE WHEN status <> 'deleted' THEN created_at END) AS newest
       FROM posts`,
    )
    .get() as StatsRow;

  const tags = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN category = 'general' THEN 1 END) AS general,
         COUNT(CASE WHEN category = 'artist' THEN 1 END) AS artist,
         COUNT(CASE WHEN category = 'character' THEN 1 END) AS character,
         COUNT(CASE WHEN category = 'copyright' THEN 1 END) AS copyright,
         COUNT(CASE WHEN category = 'species' THEN 1 END) AS species,
         COUNT(CASE WHEN category = 'meta' THEN 1 END) AS meta
       FROM tags`,
    )
    .get() as StatsRow;

  const community = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS members,
         (SELECT COUNT(*) FROM uploaders) AS uploaders,
         (SELECT COUNT(*) FROM comments) AS comments`,
    )
    .get() as StatsRow;

  const sources = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM post_sources WHERE status = 'ok') AS mirrors,
         (SELECT COUNT(*) FROM post_origins) AS origins,
         (SELECT COUNT(DISTINCT provider) FROM post_origins) AS providers`,
    )
    .get() as StatsRow;

  return {
    posts: {
      total: count(posts['total']),
      active: count(posts['active']),
      pending: count(posts['pending']),
      hidden: count(posts['hidden']),
      deleted: count(posts['deleted']),
    },
    media: {
      images: count(posts['images']),
      animated: count(posts['animated']),
      videos: count(posts['videos']),
    },
    ratings: {
      general: count(posts['general']),
      sensitive: count(posts['sensitive']),
      explicit: count(posts['explicit']),
    },
    tags: {
      total: count(tags['total']),
      general: count(tags['general']),
      artist: count(tags['artist']),
      character: count(tags['character']),
      copyright: count(tags['copyright']),
      species: count(tags['species']),
      meta: count(tags['meta']),
    },
    community: {
      members: count(community['members']),
      uploaders: count(community['uploaders']),
      comments: count(community['comments']),
    },
    sources: {
      hosted: count(posts['hosted']),
      remote: count(posts['remote']),
      mirrors: count(sources['mirrors']),
      origins: count(sources['origins']),
      providers: count(sources['providers']),
    },
    activity: {
      oldest: isoOrNull(posts['oldest']),
      newest: isoOrNull(posts['newest']),
    },
    generatedAt: new Date().toISOString(),
  };
}

export function registerStatsRoutes(app: FastifyInstance, ctx: EngineContext): void {
  app.get('/api/v1/stats', async () => readArchiveStats(ctx.sqlite));
}
