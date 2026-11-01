import { isIP } from 'node:net';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export interface ConfigIssues {
  errors: string[];
  warnings: string[];
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const KNOWN_MIRRORS = new Set(['catbox', 'imgbb', 'yourimageshare']);
const PROXY_ALIASES = new Set(['loopback', 'linklocal', 'uniquelocal']);

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.')
  );
}

function validTrustProxy(value: boolean | string): boolean {
  if (typeof value === 'boolean') return true;
  const raw = value.trim().toLowerCase();
  if (!raw) return false;
  if (PROXY_ALIASES.has(raw)) return true;

  const slash = raw.lastIndexOf('/');
  const address = slash === -1 ? raw : raw.slice(0, slash);
  const prefix = slash === -1 ? null : raw.slice(slash + 1);
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === null) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (family === 6 ? 128 : 32);
}

function checkPublicBaseUrl(
  value: string,
  production: boolean,
  errors: string[],
  warnings: string[],
): void {
  if (!value.trim() || /[\r\n]/.test(value)) {
    errors.push('PUBLIC_BASE_URL must be a single absolute http(s) URL');
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    errors.push('PUBLIC_BASE_URL must be an absolute URL, e.g. https://boorushiko.example');
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push('PUBLIC_BASE_URL must start with http:// or https://');
  }
  if (url.username || url.password) {
    errors.push('PUBLIC_BASE_URL must not contain credentials');
  }
  if (url.search || url.hash) {
    errors.push('PUBLIC_BASE_URL must be an origin without query or hash');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    errors.push('PUBLIC_BASE_URL must be an origin without a path');
  }
  if (production && url.protocol !== 'https:') {
    errors.push('PUBLIC_BASE_URL must use https in production');
  }
  if (production && isLoopback(url.hostname)) {
    errors.push('PUBLIC_BASE_URL must not point at localhost in production');
  }
  if (production && url.hostname.endsWith('.example')) {
    warnings.push('PUBLIC_BASE_URL still uses a .example placeholder');
  }
}

function checkSecurityContact(
  value: string | undefined,
  production: boolean,
  errors: string[],
  warnings: string[],
): void {
  if (!value) {
    if (production) errors.push('SECURITY_CONTACT is required in production');
    return;
  }
  if (/[\r\n]/.test(value)) {
    errors.push('SECURITY_CONTACT must be a single URI');
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    errors.push('SECURITY_CONTACT must be a mailto: or https: URI');
    return;
  }
  if (url.protocol !== 'mailto:' && url.protocol !== 'https:') {
    errors.push('SECURITY_CONTACT must be a mailto: or https: URI');
  }
  if (production && value.includes('.example')) {
    warnings.push('SECURITY_CONTACT still uses a .example placeholder');
  }
}

function checkSecurityExpires(value: string, errors: string[]): void {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    errors.push('SECURITY_EXPIRES must be an ISO-8601 date');
    return;
  }
  const now = Date.now();
  if (time <= now) errors.push('SECURITY_EXPIRES must be in the future');
  if (time > now + 365 * 24 * 60 * 60 * 1000) {
    errors.push('SECURITY_EXPIRES must be less than one year in the future');
  }
}

/** Startup checks that need more context than a single env parser can give. */
export function validateConfig(config: Config): ConfigIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = config.nodeEnv === 'production';

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    errors.push('PORT must be an integer between 1 and 65535');
  }
  if (!config.host.trim()) errors.push('HOST must not be empty');
  if (!config.dbPath.trim()) errors.push('DB_PATH must not be empty');
  if (!config.stagingDir.trim()) errors.push('STAGING_DIR must not be empty');

  checkPublicBaseUrl(config.publicBaseUrl, production, errors, warnings);
  checkSecurityContact(config.securityContact, production, errors, warnings);
  checkSecurityExpires(config.securityExpires, errors);

  if (production) {
    if (!config.uploadToken) {
      errors.push('UPLOAD_TOKEN is required in production');
    } else if (config.uploadToken === 'change-me' || config.uploadToken.length < 16) {
      errors.push('UPLOAD_TOKEN must be at least 16 characters and not the example value');
    }
  }

  const mirrors = [...new Set(config.mirrors)];
  if (mirrors.length === 0) {
    if (production) errors.push('MIRRORS must list at least one host in production');
    else warnings.push('MIRRORS is empty; uploads will stay pending');
  }

  for (const mirror of mirrors) {
    if (!KNOWN_MIRRORS.has(mirror)) errors.push(`unknown mirror in MIRRORS: ${mirror}`);
  }
  if (mirrors.includes('imgbb') && !config.imgbbKey) {
    errors.push('IMGBB_KEY is required when MIRRORS includes imgbb');
  }
  if (mirrors.includes('yourimageshare') && !config.yourImageShareKey) {
    errors.push('YOURIMAGESHARE_KEY is required when MIRRORS includes yourimageshare');
  }
  if (mirrors.length > 0 && config.minMirrors > mirrors.length) {
    errors.push(
      `MIN_MIRRORS=${config.minMirrors} but only ${mirrors.length} mirror(s) are configured`,
    );
  }
  if (production && mirrors.length > 0 && config.minMirrors < 2) {
    warnings.push('MIN_MIRRORS is below 2; one live mirror is a single point of failure');
  }

  for (const origin of config.apiCorsOrigins) {
    if (origin !== '*' && !/^https?:\/\/[^/\s]+$/i.test(origin)) {
      errors.push(`API_CORS_ORIGINS entry must be an origin like https://example.com: ${origin}`);
    }
  }

  if (!validTrustProxy(config.trustProxy)) {
    errors.push(
      'TRUST_PROXY must be false, true, loopback, linklocal, uniquelocal, an IP address or CIDR',
    );
  } else if (production && config.trustProxy === true) {
    warnings.push('TRUST_PROXY=true trusts every hop; prefer the Caddy address or loopback');
  } else if (production && config.trustProxy === false) {
    warnings.push('TRUST_PROXY=false is only correct when no reverse proxy is in front');
  }

  if (production && !config.cookieSecure) {
    warnings.push('COOKIE_SECURE is disabled in production');
  }

  if (Boolean(config.gelbooruApiKey) !== Boolean(config.gelbooruUserId)) {
    warnings.push(
      'GELBOORU_API_KEY and GELBOORU_USER_ID must be set together, otherwise Gelbooru answers 401',
    );
  } else if (!config.gelbooruApiKey && config.sourceAutoEnabled) {
    warnings.push(
      'the Gelbooru schedule is enabled but GELBOORU_API_KEY/GELBOORU_USER_ID are empty; disable it in /admin or its runs will fail with 401',
    );
  }

  if (production && !config.rateLimitEnabled) {
    warnings.push('RATE_LIMIT_ENABLED=0 leaves registration, comments and uploads unthrottled');
  }
  if (config.bodyLimitBytes < 1024) {
    errors.push('BODY_LIMIT_BYTES must be at least 1024');
  }
  if (config.requestTimeoutMs < 1000) {
    errors.push('REQUEST_TIMEOUT_MS must be at least 1000');
  }
  if (config.headersTimeoutMs < 1000) {
    errors.push('HEADERS_TIMEOUT_MS must be at least 1000');
  }

  if (!config.backupDir.trim()) errors.push('BACKUP_DIR must not be empty');
  if (config.backupKeep < 1) errors.push('BACKUP_KEEP must be at least 1');
  if (config.backupIntervalHours < 1) {
    errors.push('BACKUP_INTERVAL_HOURS must be at least 1');
  }
  if (config.maintenanceVacuumDays < 0) {
    errors.push('MAINTENANCE_VACUUM_DAYS must be zero or more');
  }
  if (config.monitorIntervalMinutes < 1) {
    errors.push('MONITOR_INTERVAL_MINUTES must be at least 1');
  }
  if (config.monitorDiskMinMb < 0) {
    errors.push('MONITOR_DISK_MIN_MB must be zero or more');
  }
  if (config.monitorQueueMax < 0) {
    errors.push('MONITOR_QUEUE_MAX must be zero or more');
  }
  if (config.monitorRssMaxMb < 0) {
    errors.push('MONITOR_RSS_MAX_MB must be zero or more');
  }
  if (config.alertCooldownMinutes < 0) {
    errors.push('ALERT_COOLDOWN_MINUTES must be zero or more');
  }
  if (Boolean(config.telegramAlertBotToken) !== Boolean(config.telegramAlertChatId)) {
    errors.push('TELEGRAM_ALERT_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID must be set together');
  }
  if (production && !config.backupEnabled) {
    warnings.push('BACKUP_ENABLED=0 leaves no automatic SQLite snapshots');
  }

  return { errors, warnings };
}

export function assertConfig(config: Config, log?: Logger): void {
  const { errors, warnings } = validateConfig(config);
  for (const warning of warnings) {
    if (log) log.warn('config warning', { warning });
    else console.warn(`[config] ${warning}`);
  }
  if (errors.length > 0) throw new ConfigError(errors);
}
