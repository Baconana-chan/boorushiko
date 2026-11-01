import { describe, expect, it } from 'vitest';
import type { HealthSnapshot } from '../src/health.js';
import { HealthMonitor, type MonitorOptions } from '../src/monitor.js';

function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  const now = new Date().toISOString();
  return {
    ok: true,
    posts: 0,
    uptimeSeconds: 3600,
    db: { ok: true, posts: 0 },
    disk: {
      path: '/data',
      freeBytes: 10 * 1024 * 1024 * 1024,
      totalBytes: 46 * 1024 * 1024 * 1024,
    },
    memory: { rssBytes: 150 * 1024 * 1024 },
    queue: { pending: 0, sourcePending: 0 },
    mirrors: [{ host: 'catbox', total: 10, ok: 10, dead: 0 }],
    maintenance: [{ name: 'backup', startedAt: now, finishedAt: now, error: null }],
    ...overrides,
  };
}

function monitorWith(sent: string[], overrides: Partial<MonitorOptions> = {}) {
  return new HealthMonitor({
    diskMinBytes: 1024 * 1024 * 1024,
    queueMax: 10,
    rssMaxBytes: 400 * 1024 * 1024,
    cooldownMinutes: 60,
    backupsEnabled: true,
    backupIntervalHours: 24,
    send: async (text) => {
      sent.push(text);
    },
    ...overrides,
  });
}

describe('health monitor', () => {
  it('alerts once per cooldown and sends one recovery message', async () => {
    const sent: string[] = [];
    const monitor = monitorWith(sent);
    const broken = snapshot({ ok: false, db: { ok: false, posts: 0, error: 'disk I/O error' } });

    await monitor.check(broken);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('database is not responding');
    expect(sent[0]).toContain('disk I/O error');

    // Still broken inside the cooldown: no duplicate spam.
    await monitor.check(broken);
    expect(sent).toHaveLength(1);

    const healthy = await monitor.check(snapshot());
    expect(healthy.sent).toHaveLength(1);
    expect(healthy.sent[0]).toContain('recovered');
    expect(sent).toHaveLength(2);

    // Recovery is reported only once.
    await monitor.check(snapshot());
    expect(sent).toHaveLength(2);
  });

  it('alerts on low disk, a long queue and a dead mirror', async () => {
    const sent: string[] = [];
    const monitor = monitorWith(sent);

    await monitor.check(
      snapshot({
        disk: { path: '/data', freeBytes: 100 * 1024 * 1024, totalBytes: 46 * 1024 * 1024 * 1024 },
        memory: { rssBytes: 500 * 1024 * 1024 },
        queue: { pending: 25, sourcePending: 2 },
        mirrors: [{ host: 'catbox', total: 4, ok: 0, dead: 4 }],
      }),
    );

    const text = sent.join('\n');
    expect(text).toContain('free disk is 100 MB');
    expect(text).toContain('process RSS is 500 MB');
    expect(text).toContain('25 pending jobs');
    expect(text).toContain('mirror catbox has no live copies');
  });

  it('complains about a stale or failed backup, but not on a fresh install', async () => {
    const sent: string[] = [];
    const monitor = monitorWith(sent);
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    await monitor.check(
      snapshot({
        maintenance: [{ name: 'backup', startedAt: old, finishedAt: old, error: null }],
      }),
    );
    expect(sent.join('\n')).toContain('no recent database backup');

    const fresh: string[] = [];
    await monitorWith(fresh).check(snapshot({ maintenance: [], uptimeSeconds: 60 }));
    expect(fresh).toEqual([]);

    const failed: string[] = [];
    const now = new Date().toISOString();
    await monitorWith(failed).check(
      snapshot({
        maintenance: [{ name: 'backup', startedAt: now, finishedAt: now, error: 'disk is full' }],
      }),
    );
    expect(failed.join('\n')).toContain('database backup failed: disk is full');
  });

  it('keeps retrying when a sender fails', async () => {
    let attempts = 0;
    const monitor = monitorWith([], {
      send: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('telegram is down');
      },
    });

    const first = await monitor.check(snapshot({ queue: { pending: 50, sourcePending: 0 } }));
    expect(first.failed.join('\n')).toContain('50 pending jobs');
    expect(first.sent).toEqual([]);

    const second = await monitor.check(snapshot({ queue: { pending: 50, sourcePending: 0 } }));
    expect(second.sent.join('\n')).toContain('50 pending jobs');
  });
});
