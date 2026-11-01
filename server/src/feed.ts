import type { Sqlite } from './db.js';
import { parseSearch, queryPosts, getPost, type PostDto } from './search.js';

const FEED_LIMIT = 50;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(value: string): string {
  return escapeXml(value);
}

export function feedPosts(
  sqlite: Sqlite,
  options: { sensitiveTags: readonly string[]; limit?: number },
): PostDto[] {
  const query = parseSearch('');
  // Explicit posts stay out of feeds and preview cards: no login, no flag, no
  // accidental 18+ thumbnail in someone's RSS reader.
  query.ratings = ['s', 'q'];
  return queryPosts(sqlite, query, {
    limit: Math.min(Math.max(options.limit ?? FEED_LIMIT, 1), 100),
    offset: 0,
    includeSensitive: false,
    sensitiveTags: options.sensitiveTags,
  }).posts;
}

function descriptionFor(post: PostDto): string {
  const tags = post.tags.map((tag) => tag.name).slice(0, 12).join(', ');
  return tags ? `#${post.id} · ${tags}` : `#${post.id}`;
}

export function rssFeed(
  sqlite: Sqlite,
  baseUrl: string,
  options: { sensitiveTags: readonly string[]; limit?: number },
): string {
  const root = baseUrl.replace(/\/+$/, '');
  const posts = feedPosts(sqlite, options);
  const now = new Date().toUTCString();

  const items = posts
    .map((post) => {
      const link = `${root}/post/${post.id}`;
      const title = descriptionFor(post);
      // A thumbnail is safe enough for a text-only feed entry; the full file is
      // hotlinked from someone else's host, so it is not embedded here.
      const image = post.rating === 's' ? `${root}/t/${post.id}` : null;
      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>
      <description>${escapeXml(descriptionFor(post))}</description>${image ? `\n      <media:content url="${escapeXml(image)}" medium="image" />` : ''}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Boorushiko — 2D art archive</title>
    <link>${escapeXml(root)}</link>
    <description>New classical 2D artwork on Boorushiko. No AI, no 3D.</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${escapeXml(`${root}/feed.xml`)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

export interface OgPost {
  id: number;
  rating: string;
  width: number;
  height: number;
  bytes: number;
  tags: Array<{ name: string; category: string }>;
}

export function loadOgPost(sqlite: Sqlite, id: number): OgPost | null {
  const post = getPost(sqlite, id);
  if (!post || post.status !== 'active') return null;
  return post;
}

/**
 * A tiny HTML document for crawlers: the Angular app never runs here, but
 * Discord, Telegram, Google and friends read the meta tags. Explicit posts get
 * no title, no tags, no image and `noindex`, so a shared link cannot leak them.
 */
export function ogHtml(
  post: OgPost | null,
  baseUrl: string,
  siteName = 'Boorushiko',
  /** True when the post carries a sensitive tag: treat it like explicit here. */
  sensitive = false,
): string {
  const root = baseUrl.replace(/\/+$/, '');
  if (!post) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Post not found · ${escapeHtml(siteName)}</title>
<meta name="robots" content="noindex, nofollow">
</head>
<body><p>This post does not exist or was removed. <a href="${escapeHtml(root)}/">Back to the gallery</a>.</p></body>
</html>
`;
  }

  const hidden = post.rating === 'e' || sensitive;
  const tags = post.tags
    .filter((tag) => tag.category !== 'meta')
    .map((tag) => tag.name)
    .slice(0, 8);
  const title = hidden ? `Post #${post.id} · ${siteName}` : `#${post.id} · ${tags.slice(0, 4).join(' ')}`;
  const description = hidden
    ? 'This post is marked for adults only. Open it on Boorushiko to view it.'
    : tags.join(', ') || 'Classical 2D artwork';
  const url = `${root}/post/${post.id}`;
  const image = `${root}/t/${post.id}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | ${escapeHtml(siteName)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(url)}">
${hidden ? '<meta name="robots" content="noindex, nofollow">' : '<meta name="robots" content="index, follow">'}
<meta property="og:type" content="article">
<meta property="og:site_name" content="${escapeHtml(siteName)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(url)}">
${hidden ? '' : `<meta property="og:image" content="${escapeHtml(image)}">\n<meta property="og:image:width" content="480">\n<meta name="twitter:card" content="summary_large_image">\n<meta name="twitter:image" content="${escapeHtml(image)}">`}
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
</head>
<body>
<p><a href="${escapeHtml(url)}">Open post #${post.id} on ${escapeHtml(siteName)}</a></p>
</body>
</html>
`;
}
