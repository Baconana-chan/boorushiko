import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Sqlite } from './db.js';

export const SESSION_COOKIE = 'boorushiko_session';

const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const KEY_LENGTH = 32;
const SCRYPT_PARAMS: ScryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export type Role = 'user' | 'moderator' | 'admin';

export interface SessionUser {
  id: number;
  username: string;
  role: Role;
  createdAt: string;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  return USERNAME_RE.test(name) ? name : null;
}

export function isValidPassword(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= PASSWORD_MIN && raw.length <= PASSWORD_MAX;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    n < 1024 ||
    n > 1_048_576 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  ) {
    return false;
  }

  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 8 || expected.length < 16) return false;

  const actual = await scryptAsync(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: Math.max(64 * 1024 * 1024, 128 * n * r * 2),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Spend the same work as a real hash so missing users do not answer faster. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await scryptAsync(password, Buffer.from('boorushiko-dummy-salt'), KEY_LENGTH, SCRYPT_PARAMS);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(sqlite: Sqlite, userId: number, config: Config): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + config.sessionTtlDays * 24 * 60 * 60 * 1000).toISOString();

  sqlite.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(createdAt);
  sqlite
    .prepare(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .run(hashToken(token), userId, createdAt, expiresAt);

  return token;
}

export function deleteSession(sqlite: Sqlite, token: string): void {
  sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function findSessionUser(sqlite: Sqlite, token: string): SessionUser | null {
  const row = sqlite
    .prepare(
      `SELECT u.id, u.username, u.role, u.created_at AS createdAt, s.expires_at AS expiresAt
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as (SessionUser & { expiresAt: string }) | undefined;

  if (!row) return null;
  if (row.expiresAt <= new Date().toISOString()) {
    sqlite.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }

  const { expiresAt: _expiresAt, ...user } = row;
  return user;
}

export function readSessionToken(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function currentUser(sqlite: Sqlite, request: FastifyRequest): SessionUser | null {
  const token = readSessionToken(request);
  return token ? findSessionUser(sqlite, token) : null;
}

export function setSessionCookie(reply: FastifyReply, token: string, config: Config): void {
  const maxAge = Math.floor(config.sessionTtlDays * 24 * 60 * 60);
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  reply.header('set-cookie', parts.join('; '));
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.cookieSecure) parts.push('Secure');
  reply.header('set-cookie', parts.join('; '));
}
