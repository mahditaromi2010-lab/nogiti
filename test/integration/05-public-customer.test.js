'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';

test('public site, customer OTP flow, orders and settings', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'owner_one', PW, 'owner');
  await pool.query("INSERT INTO products(slug,title,product_type,price_toman,status,category) VALUES('autocad-pipe','افزونه لوله‌کشی','plugin',150000,'published','تأسيسات'),('hidden','پیش‌نویس','course',1000,'draft','')");
  await pool.query("INSERT INTO product_assets(product_id,title,asset_kind,external_url,is_preview) VALUES(1,'پیش‌نمایش','link','https://example.com/p',true),(1,'فایل اصلی','link','https://example.com/full',false)");
  let srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });

  await t.test('existing public routes keep working (regression)', async () => {
    const c = new Client(srv.base);
    for (const [url, code] of [['/', 200], ['/tools', 200], ['/shop', 200], ['/shop?type=plugin', 200], ['/articles', 200], ['/about', 200], ['/login', 200], ['/admin/login', 200], ['/shop/autocad-pipe', 200], ['/shop/hidden', 404], ['/nope', 404], ['/public/css/styles.css', 200], ['/public/js/tools.js', 200], ['/public/fonts/Vazirmatn-Variable.woff2', 200], ['/public/favicon.ico', 200], ['/public/site.webmanifest', 200]]) {
      assert.equal((await c.get(url)).status, code, url);
    }
    const home = await c.get('/');
    assert.match(home.text, /nogiti-logo-96\.webp/, 'brand logo served at display size');
    for (const f of ['nogiti-logo-96.webp', 'nogiti-logo-144.webp', 'nogiti-logo.webp']) assert.equal((await c.get(`/public/images/${f}`)).status, 200, f);
    assert.match(home.text, /href="#main-content"/);
  });

  await t.test('anonymous browsing creates no session rows; pages with forms still get a working token', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int n FROM web_sessions')).rows[0].n;
    for (const url of ['/', '/tools', '/shop', '/shop/autocad-pipe', '/articles', '/about', '/nope']) {
      const r = await new Client(srv.base).get(url);
      assert.equal(r.headers.get('set-cookie'), null, `${url} sets no cookie`);
    }
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM web_sessions')).rows[0].n, before, 'no session rows written');
    const c = new Client(srv.base);
    const login = await c.get('/login');
    assert.match(login.headers.get('set-cookie') || '', /nugas\.sid=/, 'a page with a form starts a session');
    const token = login.text.match(/name="_csrf" value="([0-9a-f]{64})"/)[1];
    assert.equal([...login.text.matchAll(/name="_csrf" value="([^"]+)"/g)].every(m => m[1] === token), true, 'one token per session');
    const r = await c.post('/auth/request-code', { _csrf: token, phone: 'invalid' });
    assert.equal(r.location, '/login', 'the lazily created token is accepted (not a 403)');
  });

  await t.test('shop search folds Arabic ي/ك variants', async () => {
    const r = await new Client(srv.base).get(`/shop?q=${encodeURIComponent('تأسیسات')}`);
    assert.match(r.text, /افزونه لوله‌کشی/);
    const none = await new Client(srv.base).get(`/shop?q=${encodeURIComponent('پیش‌نویس')}`);
    assert.doesNotMatch(none.text, /\/shop\/hidden/, 'drafts never appear publicly');
  });

  await t.test('health endpoints', async () => {
    const c = new Client(srv.base);
    assert.deepEqual(JSON.parse((await c.get('/health')).text), { ok: true, service: 'nogiti-platform' });
    assert.equal((await c.get('/health/live')).status, 200);
    const ready = await c.get('/health/ready');
    assert.equal(ready.status, 200);
    assert.equal(JSON.parse(ready.text).checks.migrations, 'ok');
    assert.equal(ready.headers.get('set-cookie'), null, 'probes do not create sessions');
    // A release whose latest migration is missing must report "not ready".
    const latest = (await pool.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')).rows[0];
    await pool.query('DELETE FROM schema_migrations WHERE version=$1', [latest.version]);
    try {
      const notReady = await c.get('/health/ready');
      assert.equal(notReady.status, 503);
      assert.deepEqual(JSON.parse(notReady.text).pending, [latest.version]);
    } finally {
      await migrateUp(pool); // re-applies the idempotent migration and records it again
    }
    assert.equal((await c.get('/health/ready')).status, 200);
  });

  let customer;
  await t.test('OTP login: international number format, wrong code, return to the product page', async () => {
    customer = new Client(srv.base);
    const product = await customer.get('/shop/autocad-pipe');
    assert.match(product.text, /\/login\?next=%2Fshop%2Fautocad-pipe/);
    await customer.get('/login?next=%2Fshop%2Fautocad-pipe');
    await customer.postWithCsrf('/auth/request-code', { phone: '+98 912 000 1111', firstName: 'سارا', lastName: 'مهندس' }, '/login');
    const codePage = await customer.get('/login?step=code');
    assert.match(codePage.text, /09120001111/, 'normalised to the stored 09… format');
    const code = codePage.text.match(/کد آزمایشی محیط توسعه: <strong>(\d{6})<\/strong>/)[1];
    const wrong = await customer.postWithCsrf('/auth/verify-code', { code: code === '000000' ? '111111' : '000000' }, '/login?step=code');
    assert.equal(wrong.location, '/login?step=code');
    const ok = await customer.postWithCsrf('/auth/verify-code', { code }, '/login?step=code');
    assert.equal(ok.location, '/shop/autocad-pipe', 'returned to where the login started');
    assert.equal((await customer.get('/account')).status, 200);
    const row = (await pool.query("SELECT first_name FROM users WHERE phone='09120001111'")).rows[0];
    assert.equal(row.first_name, 'سارا');
    const replay = await customer.postWithCsrf('/auth/verify-code', { code }, '/account');
    assert.equal(replay.location, '/login', 'a used code cannot be replayed');
  });

  await t.test('open-redirect attempts through ?next= fall back to /account', async () => {
    const c = new Client(srv.base);
    await c.get('/login?next=https%3A%2F%2Fevil.example');
    await c.postWithCsrf('/auth/request-code', { phone: '09120002222' }, '/login');
    const code = (await c.get('/login?step=code')).text.match(/<strong>(\d{6})<\/strong>/)[1];
    assert.equal((await c.postWithCsrf('/auth/verify-code', { code }, '/login?step=code')).location, '/account');
  });

  await t.test('OTP attempts are capped at 5 per code', async () => {
    await srv.stop();
    srv = await startApp({ pool, uploadDir: srv.uploadDir }); // fresh per-IP limiter, so only the per-code cap applies
    customer.base = srv.base;
    const c = new Client(srv.base);
    await c.postWithCsrf('/auth/request-code', { phone: '09120003333' }, '/login');
    const code = (await c.get('/login?step=code')).text.match(/<strong>(\d{6})<\/strong>/)[1];
    const wrongCode = code === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await c.postWithCsrf('/auth/verify-code', { code: wrongCode }, '/login?step=code');
    const r = await c.postWithCsrf('/auth/verify-code', { code }, '/login?step=code');
    assert.equal(r.location, '/login', 'correct code refused after 5 failed attempts');
    assert.equal((await c.get('/account')).location, '/login');
    assert.equal((await pool.query("SELECT attempts FROM otp_codes WHERE phone='09120003333'")).rows[0].attempts, 5);
  });

  await t.test('paid content is gated; preview is public', async () => {
    const anon = new Client(srv.base);
    assert.equal((await anon.get('/secure-assets/1')).location, 'https://example.com/p');
    assert.equal((await anon.get('/secure-assets/2')).location, '/login');
    assert.equal((await customer.get('/secure-assets/2')).location, '/shop/autocad-pipe', 'not purchased');
    const uid = (await pool.query("SELECT id FROM users WHERE phone='09120001111'")).rows[0].id;
    await pool.query("INSERT INTO orders(user_id,total_toman,status,authority,ref_id,paid_at) VALUES($1,150000,'paid','A1','R1',NOW())", [uid]);
    await pool.query("INSERT INTO order_items(order_id,product_id,title_snapshot,price_toman) VALUES(1,1,'افزونه لوله‌کشی',150000)");
    assert.equal((await customer.get('/secure-assets/2')).location, 'https://example.com/full');
    const account = await customer.get('/account');
    assert.match(account.text, /افزونه لوله‌کشی/);
  });

  await t.test('checkout without a configured gateway fails safely; callbacks cannot be forged', async () => {
    await pool.query("INSERT INTO products(slug,title,product_type,price_toman,status) VALUES('second','دوره دوم','course',5000,'published')");
    const r = await customer.postWithCsrf('/checkout/3', {}, '/shop/second');
    assert.equal(r.location, '/shop/second');
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM orders')).rows[0].n, 1, 'no order created without a gateway');
    const c = new Client(srv.base);
    assert.equal((await c.get('/payments/zarinpal/callback?orderId=abc&Authority=x&Status=OK')).status, 400);
    assert.equal((await c.get('/payments/zarinpal/callback?orderId=1&Authority=WRONG&Status=OK')).status, 404);
    const paid = await c.get('/payments/zarinpal/callback?orderId=1&Authority=A1&Status=OK');
    assert.match(paid.text, /قبلاً تأیید شده/, 'idempotent for an already paid order');
  });

  await t.test('admin deactivates a customer: their live session ends and OTP login is refused', async () => {
    // Restart resets the in-process per-IP OTP limiters (all test traffic comes from 127.0.0.1); sessions live in PostgreSQL.
    await srv.stop();
    srv = await startApp({ pool, uploadDir: srv.uploadDir });
    customer.base = srv.base;
    const admin = new Client(srv.base);
    await admin.adminLogin('owner_one', PW);
    const list = await admin.get(`/admin/users?q=${encodeURIComponent('۰۹۱۲۰۰۰۱۱۱۱')}`);
    assert.match(list.text, /09120001111/, 'search by phone with Persian digits');
    assert.doesNotMatch(list.text, /09120002222/);
    const uid = (await pool.query("SELECT id FROM users WHERE phone='09120001111'")).rows[0].id;
    const r = await admin.postWithCsrf(`/admin/users/${uid}/toggle`, { back: '/admin/users?state=active' }, '/admin/users');
    assert.equal(r.location, '/admin/users?state=active');
    assert.equal((await customer.get('/account')).location, '/login', 'existing session no longer authenticated');
    await pool.query("UPDATE otp_codes SET created_at = created_at - INTERVAL '2 minutes'");
    await customer.postWithCsrf('/auth/request-code', { phone: '09120001111' }, '/login');
    const code = (await customer.get('/login?step=code')).text.match(/<strong>(\d{6})<\/strong>/)[1];
    const v = await customer.postWithCsrf('/auth/verify-code', { code }, '/login?step=code');
    assert.equal(v.location, '/login');
    assert.match((await customer.flash('/login')).message, /غیرفعال/);
    const evil = await admin.postWithCsrf(`/admin/users/${uid}/toggle`, { back: 'https://evil.example' }, '/admin/users');
    assert.equal(evil.location, '/admin/users', 'back parameter cannot redirect off-site');
  });

  await t.test('orders admin search and dashboard figures come from the database', async () => {
    const admin = new Client(srv.base);
    await admin.adminLogin('owner_one', PW);
    assert.match((await admin.get('/admin/orders?q=%231')).text, /#1</);
    assert.match((await admin.get('/admin/orders?q=R1')).text, /#1</);
    assert.match((await admin.get('/admin/orders?status=failed')).text, /سفارشی با این فیلترها پیدا نشد/);
    const dash = await admin.get('/admin');
    assert.match(dash.text, /۱۵۰٬۰۰۰ تومان/);
    assert.match(dash.text, /admin\.login\.success/, 'recent audit shown to owners');
  });

  await t.test('settings: server-side validation, persistence and public effect', async () => {
    const admin = new Client(srv.base);
    await admin.adminLogin('owner_one', PW);
    const bad = await admin.postWithCsrf('/admin/settings', { site_name: '', contact_email: 'not-an-email', instagram: 'bad handle!' }, '/admin/settings');
    assert.equal(bad.status, 422);
    assert.match(bad.text, /نشانی ایمیل معتبر نیست/);
    assert.match(bad.text, /aria-invalid="true"/);
    const ok = await admin.postWithCsrf('/admin/settings', { site_name: 'Nogiti', site_tagline: 'شعار تازه', contact_email: 'info@nogiti.ir', contact_phone: '۰۲۱-۱۲۳۴۵۶۷', instagram: '@nogiti', about_text: 'درباره' }, '/admin/settings');
    assert.equal(ok.location, '/admin/settings');
    assert.equal((await pool.query("SELECT setting_value FROM site_settings WHERE setting_key='contact_phone'")).rows[0].setting_value, '021-1234567');
    const home = await new Client(srv.base).get('/');
    assert.match(home.text, /شعار تازه/);
    assert.match(home.text, /mailto:info@nogiti\.ir/);
  });
});
