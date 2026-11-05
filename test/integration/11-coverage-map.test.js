'use strict';
// Coverage-map rebuild: admin preview while the page is switched off, base-map tile choice, the Map.ir key
// expiry warning on the admin dashboard, and the server-rendered list/form wiring of the new explorer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';
const jwt = payload => [{ typ: 'JWT', alg: 'RS256' }, payload].map(o => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.') + '.sig';
const keyExpiringIn = days => jwt({ exp: Math.floor((Date.now() + days * 864e5) / 1000) });

test('Hormozgan coverage map rebuild', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'qa_content', PW, 'content');
  await createAdmin(pool, 'qa_orders', PW, 'orders');
  await createAdmin(pool, 'qa_owner', PW, 'owner');
  let srv = await startApp({ pool, env: { FEATURE_COVERAGE_MAP: 'false', MAPIR_API_KEY: '' } });
  t.after(async () => { await srv.stop(); await pool.end(); });

  await t.test('while switched off: visitors and non-content admins get 404, content admins get a marked preview', async () => {
    assert.equal((await new Client(srv.base).get('/coverage-map')).status, 404);
    const support = new Client(srv.base);
    await support.adminLogin('qa_orders', PW);
    assert.equal((await support.get('/coverage-map')).status, 404);
    const admin = new Client(srv.base);
    await admin.adminLogin('qa_content', PW);
    const page = await admin.get('/coverage-map');
    assert.equal(page.status, 200);
    assert.match(page.text, /cm-preview-banner/);
    assert.match(page.headers.get('cache-control') || '', /no-store/);
    assert.equal((await admin.get('/api/coverage-areas')).status, 200);
    // the preview form really submits (so the admin can try the whole flow)
    const token = await admin.csrf('/coverage-map');
    const r = await admin.post('/consultation-requests', { _csrf: token, full_name: 'QA-TEST پیش‌نمایش', mobile: '09120001111', city: 'بندرعباس', project_description: 'QA-TEST درخواست آزمایشی از پیش‌نمایش' });
    assert.equal(r.status, 302);
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM consultation_requests WHERE full_name='QA-TEST پیش‌نمایش'")).rows[0].n, 1);
  });

  await t.test('no Map.ir key: page uses the CARTO base map and the dashboard stays quiet while the page is off', async () => {
    const admin = new Client(srv.base);
    await admin.adminLogin('qa_content', PW);
    const page = await admin.get('/coverage-map');
    assert.match(page.text, /data-tile-provider="carto"/);
    assert.doesNotMatch(page.text, /map\.ir\/shiveh/);
    const owner = new Client(srv.base);
    await owner.adminLogin('qa_owner', PW);
    const dash = await owner.get('/admin');
    assert.equal(dash.status, 200);
    assert.doesNotMatch(dash.text, /data-map-key=/);
  });

  await srv.stop();
  const soonKey = keyExpiringIn(3);
  srv = await startApp({ pool, env: { FEATURE_COVERAGE_MAP: 'true', MAPIR_API_KEY: soonKey } });

  await t.test('valid Map.ir key: public page requests Map.ir PNG tiles; dashboard warns in the last week', async () => {
    const visitor = new Client(srv.base);
    const page = await visitor.get('/coverage-map');
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /cm-preview-banner/);
    assert.match(page.text, /data-tile-provider="mapir"/);
    assert.match(page.text, /map\.ir\/shiveh\/xyz\/1\.0\.0\/Shiveh:Shiveh@EPSG:3857@png/);
    assert.match(page.text, /داده نمایشی/);
    // server-rendered list (works without JavaScript) with deep links per area
    const ids = (await pool.query('SELECT id FROM coverage_areas ORDER BY id')).rows.map(r => r.id);
    for (const id of ids) assert.match(page.text, new RegExp(`href="#area-${id}"`));
    const admin = new Client(srv.base);
    await admin.adminLogin('qa_owner', PW);
    const dash = await admin.get('/admin');
    assert.match(dash.text, /data-map-key="expiring"/);
    assert.doesNotMatch(dash.text, new RegExp(soonKey.split('.')[1]), 'the key itself is never printed on the dashboard');
  });

  await t.test('a failed submission re-renders with the chosen area kept and errors linked to their fields', async () => {
    const visitor = new Client(srv.base);
    const area = (await pool.query('SELECT id, project_name FROM coverage_areas ORDER BY id LIMIT 1')).rows[0];
    const token = await visitor.csrf('/coverage-map');
    const r = await visitor.post('/consultation-requests', { _csrf: token, full_name: '', mobile: '09120001111', city: '', project_description: '', coverage_area_id: String(area.id) });
    assert.equal(r.status, 422);
    assert.match(r.text, new RegExp(`id="field_coverage_area_id" value="${area.id}"`));
    assert.match(r.text, /cm-area-chip-label/);
    assert.match(r.text, /aria-describedby="err_full_name"/);
    assert.match(r.text, /aria-describedby="err_city"/);
  });

  await srv.stop();
  srv = await startApp({ pool, env: { FEATURE_COVERAGE_MAP: 'true', MAPIR_API_KEY: keyExpiringIn(-2) } });

  await t.test('expired key: map falls back to CARTO and the dashboard says so', async () => {
    assert.match((await new Client(srv.base).get('/coverage-map')).text, /data-tile-provider="carto"/);
    const admin = new Client(srv.base);
    await admin.adminLogin('qa_owner', PW);
    assert.match((await admin.get('/admin')).text, /data-map-key="expired"/);
  });
});
