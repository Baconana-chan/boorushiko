import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import { validateConfig } from '../src/config-validation.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function productionConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig({
    nodeEnv: 'production',
    publicBaseUrl: 'https://booru.example',
    uploadToken: 'x'.repeat(32),
    mirrors: ['catbox', 'imgbb'],
    imgbbKey: 'test-key',
    minMirrors: 2,
    securityContact: 'mailto:security@booru.example',
    securityExpires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
}

describe('config', () => {
  it('trusts loopback by default in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUST_PROXY', '');
    expect(loadConfig().trustProxy).toBe('loopback');
  });

  it('stays closed in development and accepts explicit proxy settings', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('TRUST_PROXY', '');
    expect(loadConfig().trustProxy).toBe(false);

    vi.stubEnv('TRUST_PROXY', '0');
    expect(loadConfig().trustProxy).toBe(false);

    vi.stubEnv('TRUST_PROXY', '1');
    expect(loadConfig().trustProxy).toBe(true);

    vi.stubEnv('TRUST_PROXY', '10.0.0.0/8');
    expect(loadConfig().trustProxy).toBe('10.0.0.0/8');
  });

  it('accepts a complete production configuration', () => {
    expect(validateConfig(productionConfig()).errors).toEqual([]);
    expect(validateConfig(productionConfig({ trustProxy: 'loopback' })).errors).toEqual([]);
    expect(validateConfig(productionConfig({ trustProxy: '10.0.0.0/8' })).errors).toEqual([]);
  });

  it('rejects placeholder production settings', () => {
    const issues = validateConfig(
      productionConfig({
        publicBaseUrl: 'http://localhost:3000',
        uploadToken: 'change-me',
        mirrors: [],
        securityContact: undefined,
      }),
    ).errors.join('\n');

    expect(issues).toContain('PUBLIC_BASE_URL must use https in production');
    expect(issues).toContain('PUBLIC_BASE_URL must not point at localhost in production');
    expect(issues).toContain('UPLOAD_TOKEN must be at least 16 characters');
    expect(issues).toContain('MIRRORS must list at least one host in production');
    expect(issues).toContain('SECURITY_CONTACT is required in production');
  });

  it('checks mirrors, proxy syntax and security.txt dates', () => {
    expect(validateConfig(productionConfig({ mirrors: ['catbox'], minMirrors: 2 })).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('MIN_MIRRORS=2')]),
    );
    expect(validateConfig(productionConfig({ imgbbKey: undefined })).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('IMGBB_KEY')]),
    );
    expect(validateConfig(productionConfig({ trustProxy: 'yes' })).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('TRUST_PROXY')]),
    );
    expect(
      validateConfig(productionConfig({ securityContact: 'security@booru.example' })).errors,
    ).toEqual(expect.arrayContaining([expect.stringContaining('SECURITY_CONTACT')]));
    expect(
      validateConfig(productionConfig({ securityExpires: '2020-01-01T00:00:00.000Z' })).errors,
    ).toEqual(expect.arrayContaining([expect.stringContaining('SECURITY_EXPIRES')]));
  });

  it('allows an empty mirror list in development', () => {
    const config = loadConfig({ nodeEnv: 'development', mirrors: [], minMirrors: 1 });
    const issues = validateConfig(config);
    expect(issues.errors).toEqual([]);
    expect(issues.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('MIRRORS is empty')]),
    );
  });

  it('accepts yourimageshare and requires its API key', () => {
    const config = productionConfig({
      mirrors: ['catbox', 'yourimageshare'],
      minMirrors: 2,
      yourImageShareKey: 'yis-key',
    });
    expect(validateConfig(config).errors).toEqual([]);
    expect(
      validateConfig({ ...config, yourImageShareKey: undefined }).errors,
    ).toEqual(expect.arrayContaining([expect.stringContaining('YOURIMAGESHARE_KEY')]));

    vi.stubEnv('YOURIMAGESHARE_KEY', '  abc  ');
    expect(loadConfig().yourImageShareKey).toBe('abc');
  });

  it('parses SENSITIVE_TAGS and supports disabling the filter', () => {
    vi.stubEnv('SENSITIVE_TAGS', 'Loli*, custom_tag, loli*');
    expect(loadConfig().sensitiveTags).toEqual(['loli*', 'custom_tag']);

    vi.stubEnv('SENSITIVE_TAGS', 'none');
    expect(loadConfig().sensitiveTags).toEqual([]);
  });

  it('enables rate limits in production and reads the perimeter limits', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(loadConfig().rateLimitEnabled).toBe(true);

    vi.stubEnv('RATE_LIMIT_ENABLED', '0');
    vi.stubEnv('BODY_LIMIT_BYTES', '2048');
    vi.stubEnv('REQUEST_TIMEOUT_MS', '5000');
    vi.stubEnv('HEADERS_TIMEOUT_MS', '1500');
    const config = loadConfig();
    expect(config.rateLimitEnabled).toBe(false);
    expect(config.bodyLimitBytes).toBe(2048);
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.headersTimeoutMs).toBe(1500);

    expect(validateConfig(config).warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('RATE_LIMIT_ENABLED')]),
    );
    expect(validateConfig({ ...config, bodyLimitBytes: 100 }).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('BODY_LIMIT_BYTES')]),
    );
  });
});
