import os from 'node:os';
import path from 'node:path';
import { parseLogLevel, type LogLevel } from './logger.js';
import { parseSensitiveTags } from './sensitive-tags.js';

export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  dbPath: string;
  stagingDir: string;
  publicBaseUrl: string;
  /** Origins allowed to read the public API from a browser; `*` allows any, empty disables. */
  apiCorsOrigins: string[];
  mirrors: string[];
  imgbbKey?: string;
  yourImageShareKey?: string;
  uploadToken?: string;
  maxUploadBytes: number;
  minMirrors: number;
  stagingTtlMinutes: number;
  jobsIntervalMs: number;
  sessionTtlDays: number;
  cookieSecure: boolean;
  trustProxy: boolean | string;
  rateLimitEnabled: boolean;
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  logLevel: LogLevel;
  logRequests: boolean;
  backupEnabled: boolean;
  backupDir: string;
  backupIntervalHours: number;
  backupKeep: number;
  maintenanceVacuumDays: number;
  monitorEnabled: boolean;
  monitorIntervalMinutes: number;
  monitorDiskMinMb: number;
  monitorQueueMax: number;
  monitorRssMaxMb: number;
  telegramAlertBotToken?: string;
  telegramAlertChatId?: string;
  alertCooldownMinutes: number;
  securityContact?: string;
  securityExpires: string;
  sensitiveTags: string[];
  commentCooldownSeconds: number;
  commentHideScore: number;
  commentHideMinVotes: number;
  commentVoteCooldownSeconds: number;
  commentVoteDailyLimit: number;
  commentModVoteWeight: number;
  commentMutualDownvoteHours: number;
  remoteThumbCacheMb: number;
  remoteThumbMaxBytes: number;
  remoteThumbTimeoutMs: number;
  /** Gelbooru gates its API per account; both values come from the account options page. */
  gelbooruApiKey?: string;
  gelbooruUserId?: string;
  sourceAutoEnabled: boolean;
  sourceAutoIntervalMinutes: number;
  sourceAutoBatch: number;
  sourceAutoDailyLimit: number;
  sourceAutoTags?: string;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

/** `TRUST_PROXY` accepts false/true or a proxy-addr expression such as `loopback`. */
function trustProxy(value: string | undefined, production: boolean): boolean | string {
  const raw = value?.trim();
  if (!raw) return production ? 'loopback' : false;
  const normalized = raw.toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off') return false;
  if (normalized === '1' || normalized === 'true' || normalized === 'on') return true;
  return raw.toLowerCase();
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const production = nodeEnv === 'production';
  const port = positiveInt(process.env.PORT, 3000);
  const dbPath = process.env.DB_PATH ?? path.resolve('data', 'boorushiko.db');
  const base: Config = {
    nodeEnv,
    port,
    host: process.env.HOST ?? '127.0.0.1',
    dbPath,
    // Zero-disk: in production point this at tmpfs, e.g. STAGING_DIR=/dev/shm/boorushiko
    stagingDir: process.env.STAGING_DIR ?? path.join(os.tmpdir(), 'boorushiko-staging'),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    // Read-only public API: `*` is safe because those endpoints never accept
    // cookies, while /admin, /auth and /me never get CORS headers at all.
    apiCorsOrigins: (process.env.API_CORS_ORIGINS ?? '*')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    mirrors: (process.env.MIRRORS ?? 'catbox')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    imgbbKey: process.env.IMGBB_KEY,
    yourImageShareKey: process.env.YOURIMAGESHARE_KEY?.trim() || undefined,
    uploadToken: process.env.UPLOAD_TOKEN,
    maxUploadBytes: positiveInt(process.env.MAX_UPLOAD_BYTES, 32 * 1024 * 1024),
    minMirrors: positiveInt(process.env.MIN_MIRRORS, 1),
    stagingTtlMinutes: positiveInt(process.env.STAGING_TTL_MINUTES, 60),
    jobsIntervalMs: positiveInt(process.env.JOBS_INTERVAL_MS, 5000),
    sessionTtlDays: positiveInt(process.env.SESSION_TTL_DAYS, 30),
    cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : production,
    // Behind Caddy only the loopback hop is trusted by default; set the actual
    // proxy address (or `true`) when the reverse proxy runs elsewhere.
    trustProxy: trustProxy(process.env.TRUST_PROXY, production),
    // Open write endpoints are throttled in production; development and tests
    // stay out of the way unless RATE_LIMIT_ENABLED=1.
    rateLimitEnabled: process.env.RATE_LIMIT_ENABLED
      ? process.env.RATE_LIMIT_ENABLED === '1'
      : production,
    bodyLimitBytes: positiveInt(process.env.BODY_LIMIT_BYTES, 1024 * 1024),
    requestTimeoutMs: positiveInt(process.env.REQUEST_TIMEOUT_MS, 60_000),
    headersTimeoutMs: positiveInt(process.env.HEADERS_TIMEOUT_MS, 20_000),
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    logRequests: process.env.LOG_REQUESTS ? process.env.LOG_REQUESTS === '1' : production,
    // Daily snapshots land next to the database by default; BACKUP_DIR can point
    // at a separate volume that an offsite job picks up.
    backupEnabled: process.env.BACKUP_ENABLED ? process.env.BACKUP_ENABLED === '1' : production,
    backupDir:
      process.env.BACKUP_DIR?.trim() ||
      path.join(dbPath === ':memory:' ? os.tmpdir() : path.dirname(dbPath), 'backups'),
    backupIntervalHours: positiveInt(process.env.BACKUP_INTERVAL_HOURS, 24),
    backupKeep: positiveInt(process.env.BACKUP_KEEP, 3),
    maintenanceVacuumDays: nonNegativeInt(process.env.MAINTENANCE_VACUUM_DAYS, 7),
    monitorEnabled: process.env.MONITOR_ENABLED ? process.env.MONITOR_ENABLED === '1' : production,
    monitorIntervalMinutes: positiveInt(process.env.MONITOR_INTERVAL_MINUTES, 5),
    monitorDiskMinMb: nonNegativeInt(process.env.MONITOR_DISK_MIN_MB, 512),
    monitorQueueMax: nonNegativeInt(process.env.MONITOR_QUEUE_MAX, 500),
    monitorRssMaxMb: nonNegativeInt(process.env.MONITOR_RSS_MAX_MB, 400),
    telegramAlertBotToken: process.env.TELEGRAM_ALERT_BOT_TOKEN?.trim() || undefined,
    telegramAlertChatId: process.env.TELEGRAM_ALERT_CHAT_ID?.trim() || undefined,
    alertCooldownMinutes: nonNegativeInt(process.env.ALERT_COOLDOWN_MINUTES, 60),
    securityContact: process.env.SECURITY_CONTACT?.trim() || undefined,
    // RFC 9116 wants Expires, and a value less than one year away.
    securityExpires:
      process.env.SECURITY_EXPIRES?.trim() ||
      new Date(Date.now() + 364 * 24 * 60 * 60 * 1000).toISOString(),
    sensitiveTags: parseSensitiveTags(process.env.SENSITIVE_TAGS),
    commentCooldownSeconds: nonNegativeInt(process.env.COMMENT_COOLDOWN_SECONDS, 5),
    commentHideScore: integer(process.env.COMMENT_HIDE_SCORE, -5),
    commentHideMinVotes: nonNegativeInt(process.env.COMMENT_HIDE_MIN_VOTES, 5),
    commentVoteCooldownSeconds: nonNegativeInt(process.env.COMMENT_VOTE_COOLDOWN_SECONDS, 1),
    commentVoteDailyLimit: nonNegativeInt(process.env.COMMENT_VOTE_DAILY_LIMIT, 50),
    commentModVoteWeight: positiveInt(process.env.COMMENT_MOD_VOTE_WEIGHT, 3),
    commentMutualDownvoteHours: nonNegativeInt(process.env.COMMENT_MUTUAL_DOWNVOTE_HOURS, 24),
    remoteThumbCacheMb: nonNegativeInt(process.env.REMOTE_THUMB_CACHE_MB, 128),
    remoteThumbMaxBytes: positiveInt(process.env.REMOTE_THUMB_MAX_BYTES, 8 * 1024 * 1024),
    remoteThumbTimeoutMs: positiveInt(process.env.REMOTE_THUMB_TIMEOUT_MS, 8000),
    gelbooruApiKey: process.env.GELBOORU_API_KEY?.trim() || undefined,
    gelbooruUserId: process.env.GELBOORU_USER_ID?.trim() || undefined,
    // Automatic imports are on in production and off in development/CI. A
    // conservative batch and daily cap keep a fresh install from crawling the
    // whole source before a moderator has looked at it.
    sourceAutoEnabled: process.env.SOURCE_AUTO_ENABLED
      ? process.env.SOURCE_AUTO_ENABLED === '1'
      : production,
    sourceAutoIntervalMinutes: positiveInt(process.env.SOURCE_AUTO_INTERVAL_MINUTES, 30),
    sourceAutoBatch: Math.min(positiveInt(process.env.SOURCE_AUTO_BATCH, 20), 200),
    sourceAutoDailyLimit: nonNegativeInt(process.env.SOURCE_AUTO_DAILY_LIMIT, 300),
    sourceAutoTags: process.env.SOURCE_AUTO_TAGS?.trim() || undefined,
  };
  return { ...base, ...overrides };
}
