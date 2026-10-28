'use strict';
/**
 * Start-up validation of environment variables.
 *
 * Adapted from Paradigmshift `apps/api/src/config/env.ts` (parseEnvironment): invalid configuration stops
 * the process before it accepts traffic, production gets stricter rules, and messages name the variable
 * but never echo its value. Re-implemented without zod to avoid a new dependency.
 */
const BOOLEAN = /^(true|false)$/;

function isUrl(value) {
  try { const u = new URL(value); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkEnvironment(env = process.env) {
  const errors = [];
  const warnings = [];
  const prod = env.NODE_ENV === 'production';

  if (env.NODE_ENV && !['development', 'test', 'production'].includes(env.NODE_ENV)) errors.push('NODE_ENV must be development, test or production');
  if (!env.DATABASE_URL) errors.push('DATABASE_URL is required');
  else if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) errors.push('DATABASE_URL must be a postgres:// connection string');
  if (env.PORT && !(Number.isInteger(Number(env.PORT)) && Number(env.PORT) > 0 && Number(env.PORT) < 65536)) errors.push('PORT must be an integer between 1 and 65535');
  if (env.APP_URL && !isUrl(env.APP_URL)) errors.push('APP_URL must be an absolute http(s) URL');
  for (const name of ['TRUST_PROXY', 'ZARINPAL_SANDBOX', 'SHOW_DEV_OTP']) {
    if (env[name] !== undefined && env[name] !== '' && !BOOLEAN.test(env[name])) errors.push(`${name} must be "true" or "false"`);
  }
  if (env.MAX_UPLOAD_MB !== undefined && env.MAX_UPLOAD_MB !== '') {
    const mb = Number(env.MAX_UPLOAD_MB);
    if (!Number.isFinite(mb) || mb < 1 || mb > 2048) errors.push('MAX_UPLOAD_MB must be a number between 1 and 2048');
  }
  if (env.DB_POOL_SIZE !== undefined && env.DB_POOL_SIZE !== '' && !(Number.isInteger(Number(env.DB_POOL_SIZE)) && Number(env.DB_POOL_SIZE) >= 1 && Number(env.DB_POOL_SIZE) <= 100)) {
    errors.push('DB_POOL_SIZE must be an integer between 1 and 100');
  }
  if (env.LOG_LEVEL && !['debug', 'info', 'warn', 'error', 'silent'].includes(env.LOG_LEVEL)) errors.push('LOG_LEVEL must be debug, info, warn, error or silent');

  if (prod) {
    const secret = env.APP_SECRET || '';
    if (secret.length < 32 || /^(replace|change|your)[-_]/i.test(secret)) errors.push('APP_SECRET must be a random value of at least 32 characters in production');
    if (!env.APP_URL) errors.push('APP_URL is required in production (payment callbacks and cookie security depend on it)');
    else if (env.APP_URL.startsWith('http://')) warnings.push('APP_URL uses http://; session cookies are not marked Secure. Serve the site over HTTPS in production.');
    if (env.APP_URL?.startsWith('https://') && env.TRUST_PROXY !== 'true') warnings.push('APP_URL is https:// but TRUST_PROXY is not true; behind a TLS-terminating proxy client IPs (rate limits, audit log) will be the proxy address.');
    if (!env.KAVENEGAR_API_KEY) warnings.push('KAVENEGAR_API_KEY is empty: customer OTP login is disabled (administrator login still works).');
    if (!env.ZARINPAL_MERCHANT_ID) warnings.push('ZARINPAL_MERCHANT_ID is empty: checkout is disabled.');
    else if (env.ZARINPAL_SANDBOX !== 'false') warnings.push('ZARINPAL_SANDBOX is not "false": payments go to the ZarinPal sandbox.');
    if (env.SHOW_DEV_OTP === 'true') warnings.push('SHOW_DEV_OTP=true is ignored in production.');
    if (env.ADMIN_PASSWORD) warnings.push('ADMIN_PASSWORD is still set in the runtime environment; remove it after running admin:create.');
  }
  return { errors, warnings };
}

module.exports = { checkEnvironment };
