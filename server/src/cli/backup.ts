/**
 * Write a consistent SQLite snapshot right now, e.g. before a deploy.
 *
 *   npm run backup        # tsx, with dev dependencies installed
 *   npm run backup:prod   # compiled dist/cli/backup.js, production install
 *
 * Uses DB_PATH, BACKUP_DIR and BACKUP_KEEP from the environment or .env. The
 * same code runs on the daily schedule inside the engine.
 */
import { createBackup } from '../backup.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { sqlite } = createDb(config.dbPath);
  try {
    const result = await createBackup({
      sqlite,
      dbPath: config.dbPath,
      dir: config.backupDir,
      keep: config.backupKeep,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    sqlite.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
