/**
 * Import remote posts from an external booru without storing image files.
 *
 *   cd server
 *   npm run import:source -- --source danbooru --limit 40 --tags "solo"
 *
 * Add `--dry-run` to print the normalized posts without touching SQLite.
 */
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { nullLogger } from '../src/logger.js';
import { createSource, sourceOptions } from '../src/sources/index.js';
import { importFromSource } from '../src/sources/importer.js';

interface Args {
  source: string;
  limit: number;
  page: number;
  pageSize: number;
  tags?: string;
  delayMs: number;
  dbPath?: string;
  dryRun: boolean;
}

const USAGE = `Usage:
  npm run import:source -- [options]

Options:
  --source <name>       Source adapter (default: danbooru)
  --limit <n>           Number of wanted posts to import (default: 40)
  --page <n>            First API page, 1-based (default: 1)
  --page-size <n>       Posts per API request, max 200 (default: 50)
  --tags <query>        Source tags; omitted means all ratings (e.g. rating:e)
  --delay <ms>          Delay between API pages (default: 1100)
  --db <path>           SQLite file (default: DB_PATH or server/data/boorushiko.db)
  --dry-run             Print normalized posts without writing to SQLite
  --help                Show this text

Examples:
  npm run import:source -- --limit 40
  npm run import:source -- --tags "solo rating:e" --limit 100
  npm run import:source -- --tags "landscape" --page 2 --limit 20`;

function positive(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function nonNegative(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--dry-run') {
      flags.set('dry-run', true);
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const equal = arg.indexOf('=');
    if (equal !== -1) {
      flags.set(arg.slice(2, equal), arg.slice(equal + 1));
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    // A single leading dash is a valid tag negation, e.g. `--tags -ai-generated`.
    flags.set(key, value);
    index += 1;
  }

  const source = String(flags.get('source') ?? 'danbooru');
  const tags = flags.get('tags');
  return {
    source,
    limit: positive(flags.get('limit') as string | undefined, 40, '--limit'),
    page: positive(flags.get('page') as string | undefined, 1, '--page'),
    pageSize: Math.min(
      positive(flags.get('page-size') as string | undefined, 50, '--page-size'),
      200,
    ),
    ...(typeof tags === 'string' ? { tags } : {}),
    delayMs: nonNegative(flags.get('delay') as string | undefined, 1100, '--delay'),
    ...(typeof flags.get('db') === 'string' ? { dbPath: String(flags.get('db')) } : {}),
    dryRun: flags.get('dry-run') === true,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.dbPath ? { dbPath: args.dbPath } : {});

  if (args.dryRun) {
    const source = createSource(args.source, sourceOptions(config));
    const page = await source.fetchPage({
      page: args.page,
      limit: args.pageSize,
      tags: args.tags,
    });
    console.log(JSON.stringify(page.posts.slice(0, args.limit), null, 2));
    console.log(`[import] dry run: ${page.posts.length} mapped posts, hasMore=${page.hasMore}`);
    return;
  }

  const { sqlite, db } = createDb(config.dbPath);
  const ctx = { sqlite, db, config, mirrors: new Map(), log: nullLogger() };

  try {
    const source = createSource(args.source, sourceOptions(config, sqlite));
    const stats = await importFromSource(ctx, source, {
      limit: args.limit,
      page: args.page,
      pageSize: args.pageSize,
      tags: args.tags,
      delayMs: args.delayMs,
      onPost: (post, result) => {
        if (!result.duplicate) {
          console.log(`[import] #${result.postId} <- ${post.provider}/${post.originId}`);
        }
      },
    });

    console.log(
      `[import] done: imported=${stats.imported}, duplicates=${stats.duplicates}, ` +
        `failed=${stats.failed}, seen=${stats.seen}, pages=${stats.pages}`,
    );
    for (const failure of stats.failures.slice(0, 5)) {
      console.warn(`[import] ${failure.originId}: ${failure.message}`);
    }
    if (stats.failed > 0) process.exitCode = 1;
  } finally {
    sqlite.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
