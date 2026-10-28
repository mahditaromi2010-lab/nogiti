'use strict';
/**
 * Minimal structured JSON logger with redaction.
 * Adapted from Paradigmshift `apps/api/src/infra/json-logger.ts` without the NestJS LoggerService coupling.
 */
const { redactValue } = require('./redaction');

const PRIORITY = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger(app = 'nogiti', level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info')) {
  const threshold = PRIORITY[level] ?? PRIORITY.info;
  const write = (lvl, message, data) => {
    if (PRIORITY[lvl] < threshold) return;
    const payload = redactValue({ timestamp: new Date().toISOString(), level: lvl, app, message, ...(data ? { data } : {}) });
    const line = JSON.stringify(payload);
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data)
  };
}

module.exports = { createLogger, logger: createLogger() };
