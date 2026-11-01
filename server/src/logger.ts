/**
 * One JSON object per line, written to stdout (info/debug) or stderr
 * (warn/error). pm2-logrotate already rotates these files; operators can pipe
 * them into jq or a log collector without parsing console prefixes.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const LOG_LEVELS = Object.keys(LEVEL_WEIGHT) as LogLevel[];

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === normalized) ?? fallback;
}

export type LogFields = Record<string, unknown>;

export type LogSink = (line: string, level: LogLevel) => void;

/** Errors serialize to name/message/stack instead of `{}`. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

const writeLine: LogSink = (line, level) => {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

export class Logger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly base: LogFields = {},
    private readonly sink: LogSink = writeLine,
  ) {}

  /** A logger bound to a module/request, e.g. `log.child({ requestId })`. */
  child(fields: LogFields): Logger {
    return new Logger(this.level, { ...this.base, ...fields }, this.sink);
  }

  debug(msg: string, fields?: LogFields): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const record: LogFields = {
      time: new Date().toISOString(),
      level,
      msg,
      ...this.base,
      ...fields,
    };
    try {
      this.sink(JSON.stringify(record, replacer), level);
    } catch {
      // Logging must never take the request down; fall back to a plain line.
      this.sink(
        JSON.stringify({ time: record.time, level, msg, logError: 'unserializable fields' }),
        level,
      );
    }
  }
}

/** A logger that drops everything; useful for scripts and tests. */
export function nullLogger(): Logger {
  return new Logger('error', {}, () => undefined);
}
