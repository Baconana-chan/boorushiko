import type { Sqlite } from './db.js';

/** SQLite builds before 3.32 cap the variables per statement at 999. */
const CHUNK = 400;

/**
 * Gelbooru does not report tag categories, so before asking its tag endpoint we
 * reuse what the database already knows from earlier imports and uploads.
 * Unknown names are simply left out; the adapter decides how to resolve them.
 */
export function existingTagCategories(sqlite: Sqlite): (names: string[]) => Map<string, string> {
  return (names: string[]): Map<string, string> => {
    const result = new Map<string, string>();
    if (names.length === 0) return result;

    for (let index = 0; index < names.length; index += CHUNK) {
      const chunk = names.slice(index, index + CHUNK);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = sqlite
        .prepare(`SELECT name, category FROM tags WHERE name IN (${placeholders})`)
        .all(...chunk) as Array<{ name: string; category: string }>;
      for (const row of rows) result.set(row.name, row.category);
    }
    return result;
  };
}
