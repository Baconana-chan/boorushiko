import type { Config } from './config.js';
import type { Db, Sqlite } from './db.js';
import type { Logger } from './logger.js';
import type { MirrorHost } from './mirrors/types.js';
import type { BooruSource } from './sources/types.js';

export interface EngineContext {
  sqlite: Sqlite;
  db: Db;
  config: Config;
  mirrors: Map<string, MirrorHost>;
  /** Structured JSON logger; modules use `ctx.log.child({ module })`. */
  log: Logger;
  /** Tests and future plugins can replace the network adapter. */
  sourceFactory?: (name: string) => BooruSource;
}
