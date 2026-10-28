'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const PDF = Buffer.from('%PDF-1.4\n%test\n');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);

test('content management and upload validation', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'content_mgr', PW, 'content');
  await createAdmin(pool, 'orders_mgr', PW, 'orders');
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const c = new Client(srv.base);
  await c.adminLogin('content_mgr', PW);
  const files = sub => fs.readdirSync(path.join(srv.uploadDir, sub));
  const multipart = async (url, fields, fileField, buffer, name, type, from) => {
    const fd = new FormData();
    fd.set('_csrf', await c.csrf(from || url));
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    if (fileField) fd.set(fileField, new Blob([buffer], { type }), name);
    return c.request('POST', url, { multipart: fd });
  };

  await t.test('malformed ids return 404 instead of a database error (was HTTP 500)', async () => {
    for (const url of ['/admin/products/abc/edit', '/admin/products/99999999999999999999/edit', '/admin/articles/1e3/edit', '/admin/products/0/edit', '/secure-assets/x']) {
      assert.equal((await c.get(url)).status, 404, url);
    }
    assert.equal((await c.postWithCsrf('/admin/products/abc/delete', {}, '/admin/products')).status, 404);
  });

  await t.test('HTML disguised as PNG is rejected and removed from disk (was accepted)', async () => {
    const before = files('covers').length;
    const r = await multipart('/admin/products', { title: 'محصول جعلی', price_toman: '1000', product_type: 'course' }, 'cover', Buffer.from('<html><script>alert(1)</script></html>'), 'x.png', 'image/png', '/admin/products/new');
    assert.equal(r.location, '/admin/products/new');
    assert.match((await c.flash('/admin/products/new')).message, /محتوای واقعی فایل/);
    assert.equal(files('covers').length, before);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM products')).rows[0].n, 0, 'nothing persisted');
  });

  await t.test('valid product with real PNG cover is created; validation errors leave no files', async () => {
    const bad = await multipart('/admin/products', { title: '', price_toman: '1000' }, 'cover', PNG, 'a.png', 'image/png', '/admin/products/new');
    assert.equal(bad.location, '/admin/products/new');
    assert.equal(files('covers').length, 0, 'cover removed when the form is invalid');
    const r = await multipart('/admin/products', { title: 'دورهٔ طراحی تأسیسات', price_toman: '۲۵۰۰۰۰', product_type: 'course', status: 'published', category: 'مكانيك' }, 'cover', PNG, 'a.png', 'image/png', '/admin/products/new');
    assert.match(r.location, /^\/admin\/products\/\d+\/edit$/);
    const p = (await pool.query('SELECT * FROM products')).rows[0];
    assert.equal(Number(p.price_toman), 250000, 'Persian digits accepted');
    assert.match(p.cover_image, /^\/media\/covers\/[0-9a-f-]+\.png$/);
    assert.equal((await new Client(srv.base).get(p.cover_image)).status, 200);
  });

  await t.test('mislabelled cover is stored under its real extension; HEIC posing as MP4 is refused', async () => {
    const id = (await pool.query('SELECT id FROM products LIMIT 1')).rows[0].id;
    // Real PNG bytes declared as JPEG by the browser.
    await multipart(`/admin/products/${id}/edit`, { title: 'دورهٔ طراحی تأسیسات', price_toman: '250000', product_type: 'course', status: 'published' }, 'cover', PNG, 'photo.jpg', 'image/jpeg', `/admin/products/${id}/edit`);
    const cover = (await pool.query('SELECT cover_image FROM products WHERE id=$1', [id])).rows[0].cover_image;
    assert.match(cover, /\.png$/, `stored as .png (got ${cover})`);
    const served = await new Client(srv.base).get(cover);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.ok(files('covers').every(f => !f.endsWith('.jpg')), 'no stray file under the declared extension');
    assert.deepEqual(files('covers'), [path.basename(cover)], 'the replaced, now unreferenced cover was deleted');
    const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64)]);
    const before = files('private').length;
    const r = await multipart(`/admin/products/${id}/assets`, { asset_title: 'عکس', asset_kind: 'video' }, 'assetFile', HEIC, 'photo.mp4', 'video/mp4', `/admin/products/${id}/edit`);
    assert.equal(r.location, `/admin/products/${id}/edit`);
    assert.equal(files('private').length, before, 'HEIC removed from disk');
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM product_assets WHERE title='عکس'")).rows[0].n, 0);
  });

  await t.test('course assets: content sniffing per kind, safe sort order, HTTPS-only links', async () => {
    const id = (await pool.query('SELECT id FROM products LIMIT 1')).rows[0].id;
    const url = `/admin/products/${id}/assets`;
    const from = `/admin/products/${id}/edit`;
    await multipart(url, { asset_title: 'جزوه', asset_kind: 'pdf', sort_order: 'abc' }, 'assetFile', PDF, 'notes.pdf', 'application/pdf', from);
    await multipart(url, { asset_title: 'ویدئو', asset_kind: 'video', sort_order: '2' }, 'assetFile', MP4, 'lesson.mp4', 'video/mp4', from);
    const spoof = await multipart(url, { asset_title: 'ویدئوی جعلی', asset_kind: 'video' }, 'assetFile', PDF, 'fake.mp4', 'video/mp4', from);
    assert.equal(spoof.location, from);
    await multipart(url, { asset_title: 'پیوند ناامن', asset_kind: 'link', external_url: 'http://insecure.example/v' }, null, null, null, null, from);
    await multipart(url, { asset_title: 'پیوند', asset_kind: 'link', external_url: 'javascript:alert(1)' }, null, null, null, null, from);
    const rows = (await pool.query('SELECT title,asset_kind,sort_order,file_key FROM product_assets ORDER BY id')).rows;
    assert.deepEqual(rows.map(r => r.title), ['جزوه', 'ویدئو']);
    assert.equal(rows[0].sort_order, 0, 'non-numeric sort order falls back to 0 (was a 500)');
    assert.equal(files('private').length, 2, 'rejected uploads deleted');
  });

  await t.test('gated files: content managers may preview, other roles and anonymous users may not', async () => {
    const asset = (await pool.query("SELECT id FROM product_assets WHERE asset_kind='pdf'")).rows[0].id;
    const r = await c.get(`/secure-assets/${asset}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    const orders = new Client(srv.base);
    await orders.adminLogin('orders_mgr', PW);
    assert.equal((await orders.get(`/secure-assets/${asset}`)).status, 302, 'orders role is not granted file access');
    assert.equal((await new Client(srv.base).get(`/secure-assets/${asset}`)).location, '/login');
    const video = (await pool.query("SELECT id FROM product_assets WHERE asset_kind='video'")).rows[0].id;
    const ranged = await c.get(`/secure-assets/${video}`, { headers: { range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206, 'HTTP range requests work for video seeking');
  });

  await t.test('articles: structured text, inline images, archive', async () => {
    const r = await multipart('/admin/articles', { title: 'راهنمای كولر', status: 'published', content: '## بخش اول\n- مورد\n<script>x</script>' }, 'inline_images', PNG, 'i.png', 'image/png', '/admin/articles/new');
    const id = r.location.match(/\d+/)[0];
    const img = (await pool.query('SELECT id FROM article_images WHERE article_id=$1', [id])).rows[0].id;
    await multipart(`/admin/articles/${id}/edit`, { title: 'راهنمای كولر', status: 'published', content: `## بخش اول\n- مورد\n<script>x</script>\n[[image:${img}]]` }, null, null, null, null, `/admin/articles/${id}/edit`);
    const slug = (await pool.query('SELECT slug FROM articles WHERE id=$1', [id])).rows[0].slug;
    const page = await new Client(srv.base).get(`/articles/${encodeURIComponent(slug)}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<h2>بخش اول<\/h2>/);
    assert.match(page.text, /<ul><li>مورد<\/li><\/ul>/);
    assert.match(page.text, /&lt;script&gt;x&lt;\/script&gt;/);
    assert.match(page.text, /<figure class="inline-article-image">/);
    const search = await new Client(srv.base).get(`/articles?q=${encodeURIComponent('کولر')}`);
    assert.match(search.text, /راهنمای كولر/, 'search folds Arabic kaf (ك) and Persian kaf (ک)');
    await c.postWithCsrf(`/admin/articles/${id}/delete`, {}, '/admin/articles');
    assert.equal((await new Client(srv.base).get(`/articles/${encodeURIComponent(slug)}`)).status, 404);
  });

  await t.test('admin list search, filter and pagination', async () => {
    for (let i = 1; i <= 30; i++) await pool.query("INSERT INTO products(slug,title,product_type,price_toman,status) VALUES($1,$2,'plugin',1000,$3)", [`bulk-${i}`, `افزونهٔ شمارهٔ ${i}`, i % 2 ? 'draft' : 'published']);
    const p1 = await c.get('/admin/products?type=plugin');
    assert.match(p1.text, /صفحهٔ ۱ از ۲/);
    const p2 = await c.get('/admin/products?type=plugin&page=2');
    assert.match(p2.text, /صفحهٔ ۲ از ۲/);
    const drafts = await c.get('/admin/products?status=draft&q=' + encodeURIComponent('شمارهٔ 1'));
    assert.match(drafts.text, /افزونهٔ شمارهٔ 1</);
    assert.doesNotMatch(drafts.text, /افزونهٔ شمارهٔ 2</);
    const wildcard = await c.get('/admin/products?q=%25');
    assert.match(wildcard.text, /پیدا نشد/, 'LIKE wildcards are matched literally');
    assert.equal((await c.get('/admin/products?page=-5&status=evil')).status, 200, 'bad filter input is ignored safely');
  });
});
