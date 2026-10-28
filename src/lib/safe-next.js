'use strict';
/**
 * Allow-list for post-login return paths. Adapted from Paradigmshift `apps/web/lib/safe-next.ts`
 * with Nogiti's customer routes. Only same-site relative paths are accepted.
 */
const DEFAULT_NEXT_PATH = '/account';
const ALLOWED_PREFIXES = ['/account', '/shop', '/articles', '/tools'];

function safeNextPath(requested, fallback = DEFAULT_NEXT_PATH) {
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > 512) return fallback;
  if (!requested.startsWith('/') || requested.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (requested.includes('\\') || /[\u0000-\u001f\u007f]/.test(requested)) return fallback;
  let url;
  try { url = new URL(requested, 'https://site.invalid'); } catch { return fallback; }
  if (url.origin !== 'https://site.invalid') return fallback;
  const p = url.pathname;
  const ok = ALLOWED_PREFIXES.some(prefix => p === prefix || p.startsWith(`${prefix}/`));
  return ok ? `${p}${url.search}` : fallback;
}

module.exports = { safeNextPath, DEFAULT_NEXT_PATH };
