import type { Sqlite } from './db.js';
import { postsByIds, type PostDto, type Rating } from './search.js';
import { sensitiveTagsClause } from './sensitive-tags.js';

/**
 * "More like this" for one post.
 *
 * It is a weighted tag-overlap search, not a picture comparison: booru tags are
 * curated, so `artist:foo character:bar copyright:baz` already describe the art
 * far better than any embedding we could afford to compute on 4 cores.
 *
 * Ranking:
 *  - each seed tag gets an inverse-document-frequency weight, so a rare artist
 *    tag counts for more than `1girl`;
 *  - categories are weighted (artist > character > copyright > species > general)
 *    because the artist and the character decide "this is the same kind of art";
 *  - meta tags (`highres`, `commentary_request`, `translated`...) are ignored:
 *    they are on almost every post and carry no identity;
 *  - a candidate's score is tapered by how many tags it actually shares
 *    (`shared / (shared + 1)`), so a post matching five tags beats a post that
 *    matches one very rare tag by accident.
 *
 * The candidate query only walks tags cheap enough to keep it bounded: the seed
 * tags are added until a scan budget is reached, so a post tagged only with
 * million-post tags cannot turn one page view into a full table scan.
 */

/** Structural tags that describe the upload, not the picture. */
const NOISE_TAGS = new Set([
  'highres',
  'lowres',
  'absurdres',
  'incredibly_absurdres',
  'huge_filesize',
  'commentary',
  'commentary_request',
  'translated',
  'partially_translated',
  'translation_request',
  'check_translation',
  'bad_id',
  'bad_pixiv_id',
  'bad_twitter_id',
  'bad_deviantart_id',
  'bad_link',
  'md5_mismatch',
  'artist_request',
  'character_request',
  'copyright_request',
  'source_request',
  'scanned',
  'jpeg_artifacts',
]);

/** How much a shared tag of this category says about the art. */
const CATEGORY_WEIGHT: Record<string, number> = {
  artist: 3,
  character: 2.5,
  copyright: 1.8,
  species: 1.6,
  general: 1,
};

const MAX_WEIGHTED_TAGS = 12;
const DEFAULT_SCAN_BUDGET = 25_000;
const MAX_LIMIT = 50;
/** Extra candidates fetched before the final score ordering is applied. */
const CANDIDATE_FACTOR = 4;

export interface RelatedOptions {
  limit: number;
  /** Visibility ceiling, same values as `rating_mode` in the search API. */
  ratings?: Rating[];
  includeSensitive?: boolean;
  sensitiveTags?: readonly string[];
  /** Post ids to leave out, e.g. the seed itself and its parent/children. */
  excludeIds?: readonly number[];
  /** Upper bound on `post_tags` rows the candidate query may walk. */
  scanBudget?: number;
}

export interface RelatedPost extends PostDto {
  /** 0..1: weighted overlap divided by the seed's own weight. */
  similarity: number;
  /** The tags this post has in common with the seed, rarest first. */
  sharedTags: string[];
}

export interface RelatedResult {
  posts: RelatedPost[];
  /** Seed tags that actually took part in the scoring (noise already dropped). */
  seedTags: string[];
}

interface SeedTag {
  id: number;
  name: string;
  category: string;
  postCount: number;
}

interface WeightedTag extends SeedTag {
  weight: number;
}

/**
 * Corpus size for IDF. `sqlite_sequence` gives the highest id ever allocated
 * without scanning the table, which is close enough for a weight; a full
 * `COUNT(*)` on a multi-million row archive would cost more than the search.
 */
function corpusSize(sqlite: Sqlite): number {
  try {
    const row = sqlite
      .prepare("SELECT seq AS seq FROM sqlite_sequence WHERE name = 'posts'")
      .get() as { seq: number } | undefined;
    const seq = Number(row?.seq);
    if (Number.isFinite(seq) && seq > 0) return seq;
  } catch {
    // Older databases may not have the AUTOINCREMENT bookkeeping table.
  }
  const row = sqlite.prepare('SELECT COUNT(*) AS count FROM posts').get() as
    { count: number } | undefined;
  return Number(row?.count) || 0;
}

function seedTags(sqlite: Sqlite, postId: number): SeedTag[] {
  return sqlite
    .prepare(
      `SELECT t.id AS id, t.name AS name, t.category AS category, t.post_count AS postCount
       FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.post_id = ?
       ORDER BY t.post_count ASC, t.name ASC`,
    )
    .all(postId) as SeedTag[];
}

/**
 * The tags worth searching by, most informative first. Tags that would blow the
 * scan budget are skipped; if every tag is that common we keep the cheapest one
 * so the result is still "something related" instead of nothing.
 */
function weightedTags(tags: SeedTag[], corpus: number, budget: number): WeightedTag[] {
  const weighted = tags
    .filter((tag) => tag.category !== 'meta' && !NOISE_TAGS.has(tag.name))
    .map((tag) => ({
      ...tag,
      weight:
        (CATEGORY_WEIGHT[tag.category] ?? 1) *
        Math.log1p(Math.max(corpus, 1) / (1 + Math.max(tag.postCount, 0))),
    }))
    .filter((tag) => tag.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const picked: WeightedTag[] = [];
  let spent = 0;
  for (const tag of weighted) {
    if (picked.length >= MAX_WEIGHTED_TAGS) break;
    if (spent + tag.postCount > budget) continue;
    picked.push(tag);
    spent += tag.postCount;
  }

  if (picked.length === 0 && weighted.length > 0) {
    const cheapest = weighted.reduce((min, tag) => (tag.postCount < min.postCount ? tag : min));
    picked.push(cheapest);
  }
  return picked;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function findRelatedPosts(
  sqlite: Sqlite,
  postId: number,
  options: RelatedOptions,
): RelatedResult {
  const limit = Math.min(Math.max(Math.floor(options.limit), 1), MAX_LIMIT);
  const budget = options.scanBudget ?? DEFAULT_SCAN_BUDGET;
  const tags = weightedTags(seedTags(sqlite, postId), corpusSize(sqlite), budget);
  if (tags.length === 0) return { posts: [], seedTags: [] };

  const seedTotal = tags.reduce((sum, tag) => sum + tag.weight, 0);
  const weightByName = new Map(tags.map((tag) => [tag.name, tag.weight]));

  const values = tags.map(() => '(?, ?)').join(', ');
  const weights: number[] = [];
  for (const tag of tags) weights.push(tag.id, round(tag.weight));

  const where: string[] = ['p.id <> ?', "p.status = 'active'"];
  const params: Array<string | number> = [...weights, postId];

  const ratings = options.ratings ?? ['s', 'q', 'e'];
  where.push(`p.rating IN (${ratings.map(() => '?').join(', ')})`);
  params.push(...ratings);

  const excluded = (options.excludeIds ?? []).filter((id) => id !== postId);
  if (excluded.length > 0) {
    where.push(`p.id NOT IN (${excluded.map(() => '?').join(', ')})`);
    params.push(...excluded);
  }

  if (options.includeSensitive === false && options.sensitiveTags?.length) {
    // Reuse the search predicate; it is written against the `p` alias.
    const clause = sensitiveTagsClause(options.sensitiveTags);
    if (clause) {
      where.push(clause.sql);
      params.push(...clause.params);
    }
  }

  const candidateLimit = Math.min(limit * CANDIDATE_FACTOR, MAX_LIMIT * CANDIDATE_FACTOR);
  const rows = sqlite
    .prepare(
      `WITH w(tag_id, weight) AS (VALUES ${values})
       SELECT p.id AS id,
              SUM(w.weight) AS overlap,
              COUNT(*) AS shared
       FROM post_tags pt
       JOIN w ON w.tag_id = pt.tag_id
       JOIN posts p ON p.id = pt.post_id
       WHERE ${where.join(' AND ')}
       GROUP BY p.id
       ORDER BY SUM(w.weight) * (COUNT(*) * 1.0 / (COUNT(*) + 1.0)) DESC,
                shared DESC,
                p.id DESC
       LIMIT ?`,
    )
    .all(...params, candidateLimit) as Array<{ id: number; overlap: number; shared: number }>;

  if (rows.length === 0) return { posts: [], seedTags: tags.map((tag) => tag.name) };

  const ids = rows.map((row) => Number(row.id));
  const matchedTags = new Map<number, string[]>();
  const placeholders = ids.map(() => '?').join(', ');
  const tagRows = sqlite
    .prepare(
      `WITH w(tag_id, weight) AS (VALUES ${values})
       SELECT pt.post_id AS postId, t.name AS name
       FROM post_tags pt
       JOIN w ON w.tag_id = pt.tag_id
       JOIN tags t ON t.id = pt.tag_id
       WHERE pt.post_id IN (${placeholders})`,
    )
    .all(...weights, ...ids) as Array<{ postId: number; name: string }>;
  for (const row of tagRows) {
    const list = matchedTags.get(row.postId) ?? [];
    list.push(row.name);
    matchedTags.set(row.postId, list);
  }

  const scored = new Map<number, { similarity: number; sharedTags: string[] }>();
  for (const row of rows) {
    const shared = Math.max(Number(row.shared), 1);
    const similarity = (Number(row.overlap) * (shared / (shared + 1))) / (seedTotal || 1);
    scored.set(Number(row.id), {
      similarity: round(Math.min(similarity, 1)),
      sharedTags: (matchedTags.get(Number(row.id)) ?? [])
        .sort((a, b) => (weightByName.get(b) ?? 0) - (weightByName.get(a) ?? 0))
        .slice(0, 4),
    });
  }

  const posts = postsByIds(sqlite, ids)
    .slice(0, limit)
    .map((post) => ({ ...post, ...scored.get(post.id)! }));

  return { posts, seedTags: tags.map((tag) => tag.name) };
}
