import type { Sqlite } from './db.js';
import { sensitiveTagsClause } from './sensitive-tags.js';

export type Rating = 's' | 'q' | 'e';
export type SearchOrder = 'new' | 'score' | 'random';

export interface TagToken {
  name: string;
  wildcard: boolean;
}

export interface SearchQuery {
  include: TagToken[];
  exclude: TagToken[];
  ratings: Rating[];
  excludeRatings: Rating[];
  order: SearchOrder;
  scoreMin?: number;
}

export interface SearchOptions {
  limit: number;
  offset: number;
  status?: string;
  /** When false, posts with a sensitive tag are omitted from the page. */
  includeSensitive?: boolean;
  sensitiveTags?: readonly string[];
  /**
   * Keyset paging for API clients: `afterId` walks newest ids forward
   * (id > afterId, ascending), `beforeId` walks the archive backwards
   * (id < beforeId, descending). Either one overrides `offset` and `order`.
   */
  afterId?: number;
  beforeId?: number;
}

export interface PostTag {
  name: string;
  category: string;
}

export interface PostDto {
  id: number;
  storageKind: string;
  md5: string;
  sha256: string;
  mime: string;
  ext: string;
  width: number;
  height: number;
  bytes: number;
  rating: string;
  score: number;
  sourceUrl: string | null;
  status: string;
  createdAt: string;
  tags: PostTag[];
}

export class SearchError extends Error {}

const TAG_CATEGORIES = new Set(['artist', 'character', 'copyright', 'species', 'meta', 'general']);
const MAX_TAGS = 25;
const MAX_RELATIVE_TAGS = 50;
const MAX_WILDCARD_TAGS = 250;
const MAX_PHRASE_WORDS = 4;

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_');
}

/** Comma is a separator, except in list-style meta filters like `rating:s,q`. */
function splitSearchInput(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .flatMap((raw) => {
      if (!raw) return [];
      const meta = raw.replace(/,+$/, '');
      if (/^[-~]?(?:rating|order):/i.test(meta)) return [meta];
      return raw.split(',').filter(Boolean);
    });
}

function toRating(value: string): Rating | null {
  switch (value.toLowerCase()) {
    case 'g':
    case 's':
    case 'safe':
    case 'general':
      return 's';
    case 'q':
    case 'questionable':
      return 'q';
    case 'e':
    case 'explicit':
      return 'e';
    default:
      return null;
  }
}

function likePattern(name: string): string {
  // `%` and `*` are intentional wildcards; `_` is a literal separator in tag names.
  const escaped = name.replace(/[\\_]/g, (match) => `\\${match}`);
  return escaped.replace(/\*/g, '%');
}

function hasWildcard(name: string): boolean {
  return name.includes('*') || name.includes('%');
}

/**
 * Supports: `tag1 tag2`, `-tag`, `tag*` / `%tag%`, `rating:s,q`, `-rating:e`,
 * `order:new|score|random`, `score:>10`, and category prefixes like `artist:foo`.
 * Multi-word tag names are resolved against the tags table (`pixel art` -> `pixel_art`).
 */
export function parseSearch(input: string): SearchQuery {
  const query: SearchQuery = {
    include: [],
    exclude: [],
    ratings: [],
    excludeRatings: [],
    order: 'new',
  };
  const seen = new Set<string>();
  let tagCount = 0;

  for (const rawToken of splitSearchInput(input)) {
    if (!rawToken) continue;
    const negated = rawToken.startsWith('-') && rawToken.length > 1;
    let token = negated ? rawToken.slice(1) : rawToken;
    if (token.startsWith('~')) token = token.slice(1);

    const meta = /^([a-z_]+):(.*)$/i.exec(token);
    if (meta) {
      const key = meta[1]!.toLowerCase();
      const value = meta[2]!.trim();

      if (key === 'rating') {
        for (const part of value.split(',').filter(Boolean)) {
          const rating = toRating(part);
          if (!rating) throw new SearchError(`unknown rating: ${part}`);
          (negated ? query.excludeRatings : query.ratings).push(rating);
        }
        continue;
      }
      if (key === 'order') {
        if (negated) throw new SearchError('order cannot be negated');
        if (value !== 'new' && value !== 'score' && value !== 'random') {
          throw new SearchError(`unknown order: ${value}`);
        }
        query.order = value;
        continue;
      }
      if (key === 'score') {
        const min = /^>(\d+)$/.exec(value);
        if (!min) throw new SearchError('score filter must look like score:>10');
        query.scoreMin = Number(min[1]);
        continue;
      }
      if (TAG_CATEGORIES.has(key)) {
        token = value;
      }
    }

    const name = normalizeTag(token);
    if (!name) continue;
    if (name.length > 100) throw new SearchError('tag is too long');
    const wildcard = hasWildcard(name);
    const bucket = negated ? query.exclude : query.include;
    const dedupeKey = `${negated ? '-' : '+'}${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    bucket.push({ name, wildcard });
    tagCount += 1;
    if (tagCount > MAX_TAGS) throw new SearchError(`too many tags (max ${MAX_TAGS})`);
  }

  return query;
}

function tagIds(sqlite: Sqlite, sql: string, params: Array<string | number>): number[] {
  return (sqlite.prepare(sql).all(...params) as Array<{ id: number }>).map((row) => Number(row.id));
}

/** Resolve a token to tag ids: exact first, then a bounded substring fallback. */
function resolveTagToken(sqlite: Sqlite, token: TagToken): number[] {
  if (token.wildcard) {
    return tagIds(
      sqlite,
      `SELECT id FROM tags WHERE name LIKE ? ESCAPE '\\'
       ORDER BY post_count DESC, name ASC LIMIT ?`,
      [likePattern(token.name), MAX_WILDCARD_TAGS],
    );
  }

  const exact = tagIds(sqlite, 'SELECT id FROM tags WHERE name = ? LIMIT 1', [token.name]);
  if (exact.length > 0) return exact;

  return tagIds(
    sqlite,
    `SELECT id FROM tags WHERE name LIKE ? ESCAPE '\\'
     ORDER BY post_count DESC, name ASC LIMIT ?`,
    [`%${likePattern(token.name)}%`, MAX_RELATIVE_TAGS],
  );
}

/**
 * Tag names are stored with underscores, but people type `pixel art` or `hatsune miku`.
 * Join the longest exact phrase available (up to four words) before falling back to
 * one-tag-per-word semantics, so ordinary `flandre solo` queries keep working.
 */
function combineTagPhrases(sqlite: Sqlite, tokens: TagToken[]): TagToken[] {
  if (tokens.length < 2) return tokens;
  const exists = sqlite.prepare('SELECT 1 FROM tags WHERE name = ? LIMIT 1');
  const result: TagToken[] = [];

  for (let index = 0; index < tokens.length;) {
    let matched = 0;
    const maxWords = Math.min(MAX_PHRASE_WORDS, tokens.length - index);
    for (let words = maxWords; words >= 2; words -= 1) {
      const slice = tokens.slice(index, index + words);
      if (slice.some((token) => token.wildcard)) continue;
      const phrase = slice.map((token) => token.name).join('_');
      if (!exists.get(phrase)) continue;
      result.push({ name: phrase, wildcard: false });
      matched = words;
      break;
    }
    if (matched > 0) {
      index += matched;
    } else {
      result.push(tokens[index]!);
      index += 1;
    }
  }

  return result;
}

function tokenClause(ids: number[], negated: boolean): { sql: string; params: number[] } {
  const placeholders = ids.map(() => '?').join(', ');
  const exists = `SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag_id IN (${placeholders})`;
  return {
    sql: negated ? `NOT EXISTS (${exists})` : `EXISTS (${exists})`,
    params: ids,
  };
}

export function queryPosts(
  sqlite: Sqlite,
  query: SearchQuery,
  options: SearchOptions,
): { posts: PostDto[]; hasMore: boolean } {
  const limit = Math.min(Math.max(Math.floor(options.limit), 1), 100);
  const offset = Math.max(Math.floor(options.offset), 0);
  const where: string[] = ['p.status = ?'];
  const params: Array<string | number> = [options.status ?? 'active'];

  if (query.ratings.length > 0) {
    where.push(`p.rating IN (${query.ratings.map(() => '?').join(', ')})`);
    params.push(...query.ratings);
  }
  for (const rating of query.excludeRatings) {
    where.push('p.rating <> ?');
    params.push(rating);
  }
  if (query.scoreMin !== undefined) {
    where.push('p.score >= ?');
    params.push(query.scoreMin);
  }
  if (options.afterId !== undefined) {
    where.push('p.id > ?');
    params.push(options.afterId);
  }
  if (options.beforeId !== undefined) {
    where.push('p.id < ?');
    params.push(options.beforeId);
  }
  if (options.includeSensitive === false && options.sensitiveTags?.length) {
    const clause = sensitiveTagsClause(options.sensitiveTags);
    if (clause) {
      where.push(clause.sql);
      params.push(...clause.params);
    }
  }
  for (const token of combineTagPhrases(sqlite, query.include)) {
    const ids = resolveTagToken(sqlite, token);
    if (ids.length === 0) {
      // An included tag that matches nothing can only produce an empty result.
      where.push('0');
      break;
    }
    const clause = tokenClause(ids, false);
    where.push(clause.sql);
    params.push(...clause.params);
  }
  for (const token of query.exclude) {
    const ids = resolveTagToken(sqlite, token);
    if (ids.length === 0) continue;
    const clause = tokenClause(ids, true);
    where.push(clause.sql);
    params.push(...clause.params);
  }

  const orderBy =
    options.afterId !== undefined
      ? 'p.id ASC'
      : options.beforeId !== undefined
        ? 'p.id DESC'
        : query.order === 'score'
          ? 'p.score DESC, p.id DESC'
          : query.order === 'random'
            ? 'RANDOM()'
            : 'p.created_at DESC, p.id DESC';

  const sql = `SELECT p.* FROM posts p
    WHERE ${where.join('\n      AND ')}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?`;

  const rows = sqlite.prepare(sql).all(...params, limit + 1, offset) as Array<
    Record<string, unknown>
  >;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const ids = page.map((row) => Number(row.id));
  const tagsByPost = new Map<number, PostTag[]>();

  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    const tagRows = sqlite
      .prepare(
        `SELECT pt.post_id AS postId, t.name AS name, t.category AS category
         FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.post_id IN (${placeholders})
         ORDER BY t.category = 'general', t.name`,
      )
      .all(...ids) as Array<{ postId: number; name: string; category: string }>;
    for (const row of tagRows) {
      const list = tagsByPost.get(row.postId) ?? [];
      list.push({ name: row.name, category: row.category });
      tagsByPost.set(row.postId, list);
    }
  }

  return { posts: page.map((row) => toDto(row, tagsByPost)), hasMore };
}

export function getPost(sqlite: Sqlite, id: number): PostDto | null {
  const row = sqlite.prepare('SELECT * FROM posts WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  if (!row) return null;
  const tags = sqlite
    .prepare(
      `SELECT t.name AS name, t.category AS category
       FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.post_id = ?
       ORDER BY t.category = 'general', t.name`,
    )
    .all(id) as PostTag[];
  return toDto(row, new Map([[id, tags]]));
}

/** Load posts by id, keeping the caller's order, with their tags attached. */
export function postsByIds(sqlite: Sqlite, ids: number[]): PostDto[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`)
    .all(...ids) as Array<Record<string, unknown>>;
  const tagRows = sqlite
    .prepare(
      `SELECT pt.post_id AS postId, t.name AS name, t.category AS category
       FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
       WHERE pt.post_id IN (${placeholders})
       ORDER BY t.category = 'general', t.name`,
    )
    .all(...ids) as Array<{ postId: number; name: string; category: string }>;

  const tagsByPost = new Map<number, PostTag[]>();
  for (const row of tagRows) {
    const list = tagsByPost.get(row.postId) ?? [];
    list.push({ name: row.name, category: row.category });
    tagsByPost.set(row.postId, list);
  }

  const byId = new Map(rows.map((row) => [Number(row.id), toDto(row, tagsByPost)]));
  return ids.map((id) => byId.get(id)).filter((post): post is PostDto => post !== undefined);
}

export function searchTags(
  sqlite: Sqlite,
  search: string,
  limit = 20,
): Array<Record<string, unknown>> {
  const normalized = normalizeTag(search);
  const cap = Math.min(Math.max(limit, 1), 50);
  const pattern = `%${likePattern(normalized)}%`;
  const prefix = `${likePattern(normalized)}%`;

  // A wildcard already scans; otherwise try the indexed prefix first and only fill
  // the remaining slots with slower substring matches.
  if (hasWildcard(normalized)) {
    return sqlite
      .prepare(
        `SELECT name, category, post_count AS postCount FROM tags
         WHERE name LIKE ? ESCAPE '\\'
         ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, post_count DESC, name ASC
         LIMIT ?`,
      )
      .all(pattern, normalized, cap) as Array<Record<string, unknown>>;
  }

  const rows = sqlite
    .prepare(
      `SELECT name, category, post_count AS postCount FROM tags
       WHERE name LIKE ? ESCAPE '\\'
       ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, post_count DESC, name ASC
       LIMIT ?`,
    )
    .all(prefix, normalized, cap) as Array<Record<string, unknown>>;
  if (rows.length >= cap) return rows;

  const more = sqlite
    .prepare(
      `SELECT name, category, post_count AS postCount FROM tags
       WHERE name LIKE ? ESCAPE '\\' AND name NOT LIKE ? ESCAPE '\\'
       ORDER BY post_count DESC, name ASC
       LIMIT ?`,
    )
    .all(pattern, prefix, cap - rows.length) as Array<Record<string, unknown>>;
  return [...rows, ...more];
}

function toDto(row: Record<string, unknown>, tagsByPost: Map<number, PostTag[]>): PostDto {
  const id = Number(row.id);
  return {
    id,
    storageKind: String(row.storage_kind),
    md5: String(row.md5),
    sha256: String(row.sha256),
    mime: String(row.mime),
    ext: String(row.ext),
    width: Number(row.width),
    height: Number(row.height),
    bytes: Number(row.bytes),
    rating: String(row.rating),
    score: Number(row.score),
    sourceUrl: row.source_url ? String(row.source_url) : null,
    status: String(row.status),
    createdAt: String(row.created_at),
    tags: tagsByPost.get(id) ?? [],
  };
}
