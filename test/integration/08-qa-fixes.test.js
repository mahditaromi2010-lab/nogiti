'use strict';
// Regressions from the 2026-11-05 QA pass (see qa-reports/2026-11-05-novingity.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

test('QA 2026-11-05 fixes', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await pool.query(`INSERT INTO products(slug,title,product_type,price_toman,status) VALUES
    ('qa-pub','QA-TEST منتشرشده','course',100000,'published'), ('qa-draft','QA-TEST پیش‌نویس','course',100000,'draft')`);
  let srv = await startApp({ pool, env: { FEATURE_COVERAGE_MAP: 'false' } });
  t.after(async () => { await srv.stop(); await pool.end(); });

  await t.test('coverage map stays hidden when the feature switch is off (default on the live site)', async () => {
    const c = new Client(srv.base);
    assert.equal((await c.get('/coverage-map')).status, 404);
    assert.equal((await c.get('/api/coverage-areas')).status, 404);
    assert.doesNotMatch((await c.get('/')).text, /href="\/coverage-map"/, 'no nav link while hidden');
    // fully hidden: the admin sections are switched off too (see 11-coverage-map.test.js)
    assert.equal((await c.get('/admin/coverage-areas')).status, 404);
  });

  await t.test('robots.txt and sitemap.xml exist; sitemap lists published content only', async () => {
    const c = new Client(srv.base);
    const robots = await c.get('/robots.txt');
    assert.equal(robots.status, 200);
    assert.match(robots.text, /Disallow: \/admin/);
    assert.match(robots.text, /Sitemap: .*\/sitemap\.xml/);
    const map = await c.get('/sitemap.xml');
    assert.equal(map.status, 200);
    assert.match(map.headers.get('content-type'), /xml/);
    assert.match(map.text, /\/shop\/qa-pub</);
    assert.doesNotMatch(map.text, /qa-draft/);
    assert.match(map.text, /\/tools</);
  });

  await t.test('English pages: English tagline, English 404, no Persian admin text leaking through', async () => {
    const c = new Client(srv.base);
    await c.get('/lang/en?next=/');
    const home = await c.get('/');
    const tagline = home.text.match(/<a class="brand"[\s\S]*?<small>([^<]*)<\/small>/)[1];
    assert.doesNotMatch(tagline, /[؀-ۿ]/, `tagline is English: ${tagline}`);
    const missing = await c.get('/no-such-page-qa');
    assert.equal(missing.status, 404);
    assert.match(missing.text, /Page not found/);
    const product = await c.get('/shop/does-not-exist');
    assert.equal(product.status, 404);
    assert.match(product.text, /Product not found/);
    const about = await c.get('/about');
    assert.doesNotMatch(about.text, /Nogiti بستری/, 'Persian about text is not shown on the English about page');
  });

  await t.test('Persian pages keep the admin-entered tagline', async () => {
    await pool.query("INSERT INTO site_settings(setting_key,setting_value) VALUES('site_tagline','QA-TEST شعار') ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value");
    await srv.stop(); srv = await startApp({ pool, env: { FEATURE_COVERAGE_MAP: 'false' } });
    const c = new Client(srv.base);
    assert.match((await c.get('/')).text, /QA-TEST شعار/);
  });

  await t.test('signed-in customer pages are not kept in the browser cache (Back after logout)', async () => {
    const c = new Client(srv.base);
    await c.postWithCsrf('/auth/request-code', { phone: '09120005555' }, '/login');
    const code = (await c.get('/login?step=code')).text.match(/<strong>(\d{6})<\/strong>/)[1];
    assert.equal((await c.postWithCsrf('/auth/verify-code', { code }, '/login?step=code')).location, '/account');
    const account = await c.get('/account');
    assert.equal(account.status, 200);
    assert.match(account.headers.get('cache-control') || '', /no-store/);
  });

  await t.test('calculator page has no inline script (blocked by CSP) and uses text inputs that accept Persian digits', async () => {
    const c = new Client(srv.base);
    const tools = await c.get('/tools');
    assert.doesNotMatch(tools.text, /<script>(?!\s*$)[^<]*NG_LOCALE/);
    assert.doesNotMatch(tools.text, /type="number"/);
    assert.match(tools.text, /inputmode="decimal"/);
  });
});
