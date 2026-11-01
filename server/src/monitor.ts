import type { HealthSnapshot } from './health.js';

export type AlertSender = (text: string) => Promise<void>;

export interface MonitorOptions {
  diskMinBytes: number;
  queueMax: number;
  rssMaxBytes: number;
  /** Re-alert for a still-broken condition at most once per cooldown. */
  cooldownMinutes: number;
  backupsEnabled: boolean;
  backupIntervalHours: number;
  /** Null sends nothing; messages are still returned so the caller can log them. */
  send: AlertSender | null;
}

interface Problem {
  key: string;
  label: string;
}

interface AlertState {
  active: boolean;
  lastSentAt: number;
  label: string;
}

export interface MonitorResult {
  sent: string[];
  failed: string[];
}

function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * Turns a health snapshot into alert messages. The same condition is reported
 * once per cooldown instead of on every tick, and a recovery message closes
 * each incident exactly once.
 */
export class HealthMonitor {
  private readonly state = new Map<string, AlertState>();

  constructor(private readonly options: MonitorOptions) {}

  private problems(snapshot: HealthSnapshot): Problem[] {
    const problems: Problem[] = [];

    if (!snapshot.db.ok) {
      problems.push({
        key: 'db',
        label: `database is not responding (${snapshot.db.error ?? 'unknown error'})`,
      });
    }

    if (snapshot.disk.freeBytes !== null && snapshot.disk.freeBytes < this.options.diskMinBytes) {
      problems.push({
        key: 'disk',
        label:
          `free disk is ${megabytes(snapshot.disk.freeBytes)} MB, ` +
          `below ${megabytes(this.options.diskMinBytes)} MB (${snapshot.disk.path ?? '?'})`,
      });
    }

    if (this.options.rssMaxBytes > 0 && snapshot.memory.rssBytes > this.options.rssMaxBytes) {
      problems.push({
        key: 'rss',
        label:
          `process RSS is ${megabytes(snapshot.memory.rssBytes)} MB, ` +
          `above ${megabytes(this.options.rssMaxBytes)} MB`,
      });
    }

    if (snapshot.queue.pending > this.options.queueMax) {
      problems.push({
        key: 'queue',
        label: `job queue holds ${snapshot.queue.pending} pending jobs (limit ${this.options.queueMax})`,
      });
    }

    for (const mirror of snapshot.mirrors) {
      if (mirror.total > 0 && mirror.ok === 0) {
        problems.push({
          key: `mirror:${mirror.host}`,
          label: `mirror ${mirror.host} has no live copies (${mirror.dead} dead)`,
        });
      }
    }

    if (this.options.backupsEnabled) {
      const backup = snapshot.maintenance.find((entry) => entry.name === 'backup');
      const staleAfterMs = this.options.backupIntervalHours * 1.5 * 60 * 60 * 1000;
      if (backup?.error) {
        problems.push({ key: 'backup', label: `database backup failed: ${backup.error}` });
      } else {
        const last = backup?.finishedAt ? Date.parse(backup.finishedAt) : Number.NaN;
        // A fresh install has no snapshot yet; wait one full interval before
        // complaining, otherwise every first start pages someone.
        const stale = Number.isFinite(last)
          ? Date.now() - last > staleAfterMs
          : snapshot.uptimeSeconds * 1000 > staleAfterMs;
        if (stale) problems.push({ key: 'backup', label: 'no recent database backup' });
      }
    }

    return problems;
  }

  private async deliver(text: string): Promise<boolean> {
    if (!this.options.send) return true;
    try {
      await this.options.send(text);
      return true;
    } catch {
      return false;
    }
  }

  async check(snapshot: HealthSnapshot): Promise<MonitorResult> {
    const now = Date.now();
    const cooldownMs = this.options.cooldownMinutes * 60 * 1000;
    const problems = this.problems(snapshot);
    const result: MonitorResult = { sent: [], failed: [] };

    for (const problem of problems) {
      const state = this.state.get(problem.key);
      if (state?.active) {
        if (now - state.lastSentAt < cooldownMs) continue;
      }
      const text = `[Boorushiko] ${problem.label}`;
      if (await this.deliver(text)) {
        result.sent.push(text);
        this.state.set(problem.key, { active: true, lastSentAt: now, label: problem.label });
      } else {
        result.failed.push(text);
      }
    }

    // Close incidents that are no longer present, once each.
    for (const [key, state] of this.state) {
      if (!state.active) continue;
      if (problems.some((problem) => problem.key === key)) continue;
      const text = `[Boorushiko] recovered: ${state.label}`;
      if (await this.deliver(text)) {
        result.sent.push(text);
        this.state.delete(key);
      } else {
        result.failed.push(text);
      }
    }

    return result;
  }
}

/** Telegram Bot API sender; token and chat id stay in server/.env. */
export function telegramSender(botToken: string, chatId: string, timeoutMs = 10_000): AlertSender {
  return async (text) => {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`telegram sendMessage failed with HTTP ${response.status}`);
    }
  };
}
