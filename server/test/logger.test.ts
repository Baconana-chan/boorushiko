import { describe, expect, it } from 'vitest';
import { Logger, parseLogLevel } from '../src/logger.js';

function collect(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('structured logger', () => {
  it('writes one JSON object per line with bound fields', () => {
    const { lines, sink } = collect();
    const log = new Logger('info', { app: 'boorushiko' }, sink).child({ module: 'jobs' });

    log.info('job done', { jobId: 7, durationMs: 12 });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({
      level: 'info',
      msg: 'job done',
      app: 'boorushiko',
      module: 'jobs',
      jobId: 7,
      durationMs: 12,
    });
    expect(typeof record.time).toBe('string');
  });

  it('filters below the configured level and serializes errors', () => {
    const { lines, sink } = collect();
    const log = new Logger('warn', {}, sink);

    log.info('not written');
    log.warn('problem', { err: new Error('boom') });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.level).toBe('warn');
    expect(record.err).toMatchObject({ name: 'Error', message: 'boom' });
    expect(record.err.stack).toContain('boom');
  });

  it('parses levels and falls back to info', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('noisy')).toBe('info');
  });
});
