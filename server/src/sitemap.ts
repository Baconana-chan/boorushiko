import type { Sqlite } from './db.js';

export const SITEMAP_PAGE_SIZE = 50_000;

const STATIC_PATHS = ['/', '/stats', '/about', '/help', '/rules', '/dmca', '/tos'];

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
};

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => XML_ESCAPES[char] ?? char);
}

function siteBase(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/\/+$/, '');
}

function urlEntry(loc: string, lastmod?: string): string {
  return `<url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ''}</url>`;
}

function activePostCount(sqlite: Sqlite): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS count FROM posts WHERE status = 'active'")
    .get() as {
    count: number;
  };
  return Number(row.count);
}

function activePostPages(sqlite: Sqlite): number {
  return Math.max(1, Math.ceil(activePostCount(sqlite) / SITEMAP_PAGE_SIZE));
}

export function robotsTxt(publicBaseUrl: string): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /account',
    'Disallow: /upload',
    'Disallow: /auth',
    'Disallow: /api/',
    '',
    `Sitemap: ${siteBase(publicBaseUrl)}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapIndex(sqlite: Sqlite, publicBaseUrl: string): string {
  const base = siteBase(publicBaseUrl);
  const pages = activePostPages(sqlite);
  const latest = sqlite
    .prepare("SELECT MAX(updated_at) AS lastmod FROM posts WHERE status = 'active'")
    .get() as { lastmod: string | null };
  const lastmod = latest.lastmod ? latest.lastmod.slice(0, 10) : undefined;

  const entries = [
    `<sitemap><loc>${escapeXml(`${base}/sitemap-pages.xml`)}</loc></sitemap>`,
    ...Array.from(
      { length: pages },
      (_, index) =>
        `<sitemap><loc>${escapeXml(`${base}/sitemap-posts-${index + 1}.xml`)}</loc>${
          lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ''
        }</sitemap>`,
    ),
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    '</sitemapindex>',
    '',
  ].join('\n');
}

export function pagesSitemap(publicBaseUrl: string): string {
  const base = siteBase(publicBaseUrl);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...STATIC_PATHS.map((path) => urlEntry(`${base}${path}`)),
    '</urlset>',
    '',
  ].join('\n');
}

/** Returns null for a page outside the current range so crawlers get a 404. */
export function postsSitemap(sqlite: Sqlite, publicBaseUrl: string, page: number): string | null {
  if (!Number.isSafeInteger(page) || page < 1 || page > activePostPages(sqlite)) return null;

  const base = siteBase(publicBaseUrl);
  const rows = sqlite
    .prepare(
      `SELECT id, updated_at AS updatedAt FROM posts
       WHERE status = 'active'
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(SITEMAP_PAGE_SIZE, (page - 1) * SITEMAP_PAGE_SIZE) as Array<{
    id: number;
    updatedAt: string;
  }>;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...rows.map((row) => urlEntry(`${base}/post/${row.id}`, row.updatedAt.slice(0, 10))),
    '</urlset>',
    '',
  ].join('\n');
}
