'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapTileConfig, mapirKeyStatus, jwtExpiry, MAPIR_TILE_URL } = require('../../src/lib/map-tiles');

const NOW = Date.parse('2026-11-05T12:00:00Z');
const jwt = payload => [{ typ: 'JWT', alg: 'RS256' }, payload].map(o => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.') + '.signature';
const keyExpiringIn = days => jwt({ aud: '1', exp: Math.floor((NOW + days * 864e5) / 1000), scopes: ['basic'] });

test('jwtExpiry reads exp from the payload and rejects garbage', () => {
  assert.equal(jwtExpiry(jwt({ exp: 1764859335 })).toISOString(), new Date(1764859335000).toISOString());
  assert.equal(jwtExpiry('not-a-jwt'), null);
  assert.equal(jwtExpiry('a.b.c'), null);
  assert.equal(jwtExpiry(jwt({ sub: 'no exp' })), null);
});

test('no key → CARTO fallback, never a Map.ir URL', () => {
  const cfg = mapTileConfig({}, NOW);
  assert.equal(cfg.provider, 'carto');
  assert.match(cfg.url, /basemaps\.cartocdn\.com/);
  assert.equal(mapirKeyStatus({}, NOW).reason, 'missing');
});

test('valid key → Map.ir PNG tiles with the key, Map.ir + OSM credit, CARTO kept as network fallback', () => {
  const key = keyExpiringIn(20);
  const cfg = mapTileConfig({ MAPIR_API_KEY: ` ${key} ` }, NOW);
  assert.equal(cfg.provider, 'mapir');
  assert.ok(cfg.url.startsWith(MAPIR_TILE_URL + '?x-api-key='));
  assert.match(cfg.url, /@png\/\{z\}\/\{x\}\/\{y\}\.png/);
  assert.ok(cfg.url.endsWith(encodeURIComponent(key)), 'key is trimmed and URL-encoded');
  assert.match(cfg.attribution, /Map\.ir/);
  assert.match(cfg.attribution, /OpenStreetMap/);
  assert.equal(cfg.fallback.provider, 'carto');
  const st = mapirKeyStatus({ MAPIR_API_KEY: key }, NOW);
  assert.equal(st.usable, true); assert.equal(st.daysLeft, 20); assert.equal(st.expiringSoon, false);
});

test('key in its last week is still used but flagged; expired or malformed keys fall back', () => {
  const soon = mapirKeyStatus({ MAPIR_API_KEY: keyExpiringIn(3) }, NOW);
  assert.equal(soon.usable, true); assert.equal(soon.expiringSoon, true);
  const expired = keyExpiringIn(-1);
  assert.equal(mapirKeyStatus({ MAPIR_API_KEY: expired }, NOW).reason, 'expired');
  assert.equal(mapTileConfig({ MAPIR_API_KEY: expired }, NOW).provider, 'carto');
  assert.equal(mapirKeyStatus({ MAPIR_API_KEY: 'plain-string' }, NOW).reason, 'malformed');
  assert.equal(mapTileConfig({ MAPIR_API_KEY: 'plain-string' }, NOW).provider, 'carto');
});
