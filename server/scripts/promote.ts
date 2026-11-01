/**
 * Bootstrap the first moderator/admin on an existing database.
 *
 *   cd server
 *   npm run promote -- <username>
 *   npm run promote -- <username> --role moderator
 *   npm run promote -- <username> --db data/demo.db
 *
 * The account must already exist; register it through the site first. The change is
 * written to `audit_log` so the role grant is visible in the admin audit trail.
 */
import { existsSync } from 'node:fs';
import { normalizeUsername, type Role } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';

interface Args {
  username: string;
  role: Role;
  dbPath?: string;
}

const ROLES = new Set<Role>(['user', 'moderator', 'admin']);

const USAGE = `Usage:
  npm run promote -- <username> [options]

Options:
  --role <role>   user, moderator or admin (default: admin)
  --db <path>     SQLite file (default: DB_PATH or server/data/boorushiko.db)
  --help          Show this text

The account must already exist. Register it through the site, then run this script.
Examples:
  npm run promote -- alice
  npm run promote -- alice --role moderator
  npm run promote -- alice --db data/demo.db`;

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let role: Role = 'admin';
  let dbPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const equal = arg.indexOf('=');
    const key = equal === -1 ? arg.slice(2) : arg.slice(2, equal);
    const value = equal === -1 ? argv[index + 1] : arg.slice(equal + 1);
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);

    if (key === 'role') {
      if (!ROLES.has(value as Role)) throw new Error('--role must be user, moderator or admin');
      role = value as Role;
    } else if (key === 'db') {
      dbPath = value;
    } else {
      throw new Error(`unknown option: --${key}`);
    }
    if (equal === -1) index += 1;
  }

  if (positional.length !== 1) throw new Error('expected exactly one username');
  return { username: positional[0]!, role, ...(dbPath ? { dbPath } : {}) };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const username = normalizeUsername(args.username);
  if (!username) {
    throw new Error('username must be 3-24 lowercase letters, digits or underscore');
  }

  const config = loadConfig(args.dbPath ? { dbPath: args.dbPath } : {});
  if (config.dbPath !== ':memory:' && !existsSync(config.dbPath)) {
    throw new Error(`database not found: ${config.dbPath}`);
  }
  const { sqlite } = createDb(config.dbPath);

  try {
    const row = sqlite
      .prepare('SELECT id, username, role FROM users WHERE username_lower = ?')
      .get(username) as { id: number; username: string; role: Role } | undefined;
    if (!row) {
      throw new Error(`user "${username}" not found; register the account first`);
    }

    if (row.role === args.role) {
      console.log(`[promote] ${row.username} is already ${args.role}`);
      return;
    }

    const now = new Date().toISOString();
    sqlite.transaction(() => {
      sqlite.prepare('UPDATE users SET role = ? WHERE id = ?').run(args.role, row.id);
      sqlite
        .prepare(
          `INSERT INTO audit_log (actor_id, action, target_type, target_id, reason, details, created_at)
           VALUES (NULL, 'user.role', 'user', ?, NULL, ?, ?)`,
        )
        .run(row.id, JSON.stringify({ from: row.role, to: args.role, via: 'cli' }), now);
    })();

    console.log(`[promote] ${row.username}: ${row.role} -> ${args.role}`);
  } finally {
    sqlite.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`[promote] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
