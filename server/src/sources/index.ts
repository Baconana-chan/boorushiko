import type { Config } from '../config.js';
import type { Sqlite } from '../db.js';
import { existingTagCategories } from '../source-tags.js';
import { DanbooruSource } from './danbooru.js';
import { GelbooruSource } from './gelbooru.js';
import type { BooruSource, SourceHttpOptions } from './types.js';

export const SOURCE_NAMES = ['danbooru', 'gelbooru'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export function createSource(name: string, options: SourceHttpOptions = {}): BooruSource {
  switch (name.toLowerCase()) {
    case 'danbooru':
      return new DanbooruSource(options);
    case 'gelbooru':
      return new GelbooruSource(options);
    default:
      throw new Error(`unknown source: ${name}`);
  }
}

/** Credentials and the local tag-category cache an adapter may use. */
export function sourceOptions(config: Config, sqlite?: Sqlite): SourceHttpOptions {
  return {
    ...(config.gelbooruApiKey ? { apiKey: config.gelbooruApiKey } : {}),
    ...(config.gelbooruUserId ? { userId: config.gelbooruUserId } : {}),
    ...(sqlite ? { tagCategories: existingTagCategories(sqlite) } : {}),
  };
}

export { DanbooruSource, parseDanbooruPost } from './danbooru.js';
export { GelbooruSource, parseGelbooruPost } from './gelbooru.js';
export type { BooruSource, SourcePage, SourcePageRequest, SourcePost } from './types.js';
