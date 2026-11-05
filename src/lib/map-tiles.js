'use strict';
/**
 * Base-map tiles for the coverage map.
 *
 * Map.ir (Iranian provider) is used when MAPIR_API_KEY holds a key that has not expired. The key is a JWT
 * whose payload carries `exp`; free-plan keys are short-lived (about a month), and Map.ir answers an
 * invalid or expired key with "200 OK" plus a picture tile saying "unauthorized" — the browser cannot
 * detect that. So the server reads the expiry itself and falls back to the previous provider (CARTO,
 * OpenStreetMap data) when the key is missing, malformed or expired, and the admin dashboard warns a week
 * before it runs out. The signature is not verified here: this only decides which tiles to request;
 * Map.ir itself enforces the key.
 *
 * The key is never stored in the repository — it comes from the server's .env (see docker-compose.yml).
 */

const MAPIR_TILE_URL = 'https://map.ir/shiveh/xyz/1.0.0/Shiveh:Shiveh@EPSG:3857@png/{z}/{x}/{y}.png';
const EXPIRY_WARNING_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const FALLBACK_TILES = Object.freeze({
  provider: 'carto',
  url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  subdomains: 'abcd',
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>'
});

/** Reads `exp` (seconds) from a JWT without verifying it. Returns a Date or null. */
function jwtExpiry(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number.isFinite(payload.exp) ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** Status of the configured Map.ir key, for the tile choice and the admin dashboard warning. */
function mapirKeyStatus(env = process.env, now = Date.now()) {
  const key = String(env.MAPIR_API_KEY || '').trim();
  if (!key) return { configured: false, usable: false, reason: 'missing' };
  const expiresAt = jwtExpiry(key);
  if (!expiresAt) return { configured: true, usable: false, reason: 'malformed' };
  const msLeft = expiresAt.getTime() - now;
  const daysLeft = Math.floor(msLeft / DAY_MS);
  if (msLeft <= 0) return { configured: true, usable: false, reason: 'expired', expiresAt, daysLeft };
  return { configured: true, usable: true, expiresAt, daysLeft, expiringSoon: daysLeft < EXPIRY_WARNING_DAYS };
}

/** Tile layer settings for the browser (public data — the key ends up in tile URLs either way). */
function mapTileConfig(env = process.env, now = Date.now()) {
  const status = mapirKeyStatus(env, now);
  if (!status.usable) return { ...FALLBACK_TILES, fallback: null };
  return {
    provider: 'mapir',
    url: `${MAPIR_TILE_URL}?x-api-key=${encodeURIComponent(String(env.MAPIR_API_KEY).trim())}`,
    subdomains: '',
    maxZoom: 18,
    attribution: '&copy; <a href="https://map.ir" target="_blank" rel="noopener">Map.ir</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    // used by the browser if Map.ir is unreachable (network errors); see public/js/map.js
    fallback: FALLBACK_TILES
  };
}

module.exports = { mapTileConfig, mapirKeyStatus, jwtExpiry, MAPIR_TILE_URL, FALLBACK_TILES, EXPIRY_WARNING_DAYS };
