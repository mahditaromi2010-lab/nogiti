'use strict';
// Free products (owner decision 2026-11-05: price 0 = "free with one click").
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';
async function form(c, url, fields, from) {
  const fd = new FormData();
  fd.set('_csrf', await c.csrf(from || url));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return c.request('POST', url, { multipart: fd });
}
async function signIn(srv, phone) {
  const c = new Client(srv.base);
  await c.postWithCsrf('/auth/request-code', { phone }, '/login');
  const code = (await c.get('/login?step=code')).text.match(/<strong>(\d{6})<\/strong>/)[1];
  assert.equal((await c.postWithCsrf('/auth/verify-code', { code }, '/login?step=code')).location, '/account');
  return c;
}

test('free products: one click adds them to the library, no payment gateway', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'free_owner', PW, 'owner');
  const srv = await startApp({ pool, env: { ZARINPAL_MERCHANT_ID: '' } });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const admin = new Client(srv.base);
  await admin.postWithCsrf('/admin/login', { username: 'free_owner', password: PW }, '/admin/login');

  await t.test('admin can save price 0 (free) but not a price between 1 and 99', async () => {
    await form(admin, '/admin/products', { title: 'QA-TEST دوره رایگان', price_toman: '0', product_type: 'course', status: 'published' }, '/admin/products/new');
    assert.equal((await pool.query("SELECT price_toman FROM products WHERE title='QA-TEST دوره رایگان'")).rows[0].price_toman, '0');
    await form(admin, '/admin/products', { title: 'QA-TEST خیلی ارزان', price_toman: '50', product_type: 'course', status: 'published' }, '/admin/products/new');
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM products WHERE title='QA-TEST خیلی ارزان'")).rows[0].n, 0);
  });

  const free = async () => (await pool.query("SELECT id, slug FROM products WHERE title='QA-TEST دوره رایگان'")).rows[0];

  await t.test('product page says free, and asks visitors to sign in to get it', async () => {
    const page = await new Client(srv.base).get(`/shop/${(await free()).slug}`);
    assert.match(page.text, /<strong>رایگان<\/strong>/);
    assert.match(page.text, /ورود و دریافت رایگان/);
    assert.doesNotMatch(page.text, /۰ تومان/);
    assert.match((await new Client(srv.base).get('/shop')).text, /رایگان/, 'shop card shows Free');
  });

  await t.test('signed-in customer gets it with one click, even with no payment gateway configured', async () => {
    const c = await signIn(srv, '09120007777');
    const p = await free();
    assert.match((await c.get(`/shop/${p.slug}`)).text, /دریافت رایگان/);
    const r = await c.postWithCsrf(`/checkout/${p.id}`, {}, `/shop/${p.slug}`);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/account');
    const order = (await pool.query("SELECT o.status, o.total_toman, o.gateway, o.paid_at FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE oi.product_id=$1", [p.id])).rows;
    assert.equal(order.length, 1);
    assert.equal(order[0].status, 'paid');
    assert.equal(order[0].total_toman, '0');
    assert.equal(order[0].gateway, 'free');
    assert.ok(order[0].paid_at);
    assert.match((await c.get(`/shop/${p.slug}`)).text, /ورود به کتابخانه|کتابخانه/);
    // second click and a burst of parallel clicks never create another order
    await c.postWithCsrf(`/checkout/${p.id}`, {}, `/shop/${p.slug}`);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM order_items WHERE product_id=$1', [p.id])).rows[0].n, 1);
  });

  await t.test('parallel clicks by a new customer create exactly one order', async () => {
    const c = await signIn(srv, '09120008888');
    const p = await free();
    const token = await c.csrf(`/shop/${p.slug}`);
    await Promise.all(Array.from({ length: 5 }, () => c.post(`/checkout/${p.id}`, { _csrf: token })));
    const n = (await pool.query("SELECT COUNT(*)::int n FROM order_items oi JOIN orders o ON o.id=oi.order_id JOIN users u ON u.id=o.user_id WHERE oi.product_id=$1 AND u.phone LIKE '%9120008888'", [p.id])).rows[0].n;
    assert.equal(n, 1);
  });

  await t.test('paid products still require the gateway', async () => {
    await form(admin, '/admin/products', { title: 'QA-TEST دوره پولی', price_toman: '150000', product_type: 'course', status: 'published' }, '/admin/products/new');
    const paid = (await pool.query("SELECT id, slug FROM products WHERE title='QA-TEST دوره پولی'")).rows[0];
    const c = await signIn(srv, '09120009999');
    const r = await c.postWithCsrf(`/checkout/${paid.id}`, {}, `/shop/${paid.slug}`);
    assert.equal(decodeURIComponent(r.location), `/shop/${paid.slug}`);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM order_items WHERE product_id=$1', [paid.id])).rows[0].n, 0);
  });
});
