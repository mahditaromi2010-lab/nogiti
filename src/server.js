require('dotenv').config();
const { Pool } = require('pg');
const { createApp } = require('./app');
const { logger } = require('./lib/logger');

const { checkEnvironment } = require('./lib/config');

const { errors, warnings } = checkEnvironment(process.env);
for (const warning of warnings) logger.warn('configuration warning', { warning });
if (errors.length) {
  for (const error of errors) logger.error('configuration error', { problem: error });
  logger.error('refusing to start: fix the environment variables listed above (see docs/ENVIRONMENT-fa.md)');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_SIZE || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});
pool.on('error', error => logger.error('idle database client error', { error }));

const { app, close } = createApp({ pool, logger });
const PORT = Number(process.env.PORT || 3000);

pool.query('SELECT 1').then(() => logger.info('database connection ready')).catch(error => logger.error('database connection failed', { error }));
const server = app.listen(PORT, () => logger.info('Nogiti listening', { port: PORT }));

let stopping = false;
const shutdown = signal => {
  if (stopping) return;
  stopping = true;
  logger.info('shutting down', { signal });
  close();
  const force = setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000));
  force.unref();
  server.close(() => pool.end().finally(() => process.exit(0)));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
