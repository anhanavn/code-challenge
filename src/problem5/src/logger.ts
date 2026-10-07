import pino, { type Logger } from 'pino';
import type { Config } from './config.js';

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    // Human-readable logs locally, structured JSON everywhere else.
    transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  });
}
