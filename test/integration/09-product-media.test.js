'use strict';
// Multi-part product media (2026-11-05): several gallery images per upload (plugins and courses), plugin
// tutorial parts with several images each, and course video parts uploaded together and numbered.
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);

async function upload(c, url, fields, files, from) {
  const fd = new FormData();
  fd.set('_csrf', await c.csrf(from || url));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const [field, buf, name, type] of files) fd.append(field, new Blob([buf], { type }), name);
  return c.request('POST', url, { multipart: fd });
}
const count = async (pool, sql, args) => (await pool.query(sql, args)).rows[0].n;

test('product media in several parts', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'media_owner', PW, 'owner');
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const admin = new Client(srv.base);
  await admin.postWithCsrf('/admin/login', { username: 'media_owner', password: PW }, '/admin/login');
  const make = async (type, title) => {
    const r = await upload(admin, '/admin/products', { title, price_toman: '150000', product_type: type, status: 'published' }, [], '/admin/products/new');
    assert.equal(r.status, 302);
    return (await pool.query('SELECT id, slug FROM products WHERE title=$1', [title])).rows[0];
  };
  const plugin = await make('plugin', 'QA-TEST افزونه چندتصویری');
  const course = await make('course', 'QA-TEST دوره چندقسمتی');
  const editUrl = id => `/admin/products/${id}/edit`;

  await t.test('gallery: several images in one upload, appended in order (plugin and course)', async () => {
    for (const p of [plugin, course]) {
      const r = await upload(admin, `/admin/products/${p.id}/gallery`, { caption: 'QA-TEST نما' }, [1, 2, 3].map(i => ['images', PNG, `g${i}.png`, 'image/png']), editUrl(p.id));
      assert.equal(r.status, 302);
      await upload(admin, `/admin/products/${p.id}/gallery`, {}, [['images', PNG, 'g4.png', 'image/png']], editUrl(p.id));
      const rows = (await pool.query('SELECT sort_order FROM product_gallery_images WHERE product_id=$1 ORDER BY sort_order,id', [p.id])).rows.map(r => r.sort_order);
      assert.deepEqual(rows, [1, 2, 3, 4]);
    }
    const page = await new Client(srv.base).get(`/shop/${course.slug}`);
    assert.equal((page.text.match(/class="plugin-gallery-item"/g) || []).length, 4, 'course page shows its gallery');
  });

  await t.test('plugin tutorial part: several images at creation, more added later, single image deletable', async () => {
    const r = await upload(admin, `/admin/products/${plugin.id}/demo-steps`, { title: 'QA-TEST پارت ۱ — نصب', body: 'توضیح' }, [1, 2].map(i => ['images', PNG, `s${i}.png`, 'image/png']), editUrl(plugin.id));
    assert.equal(r.status, 302);
    const step = (await pool.query('SELECT id FROM product_demo_steps WHERE product_id=$1', [plugin.id])).rows[0];
    assert.equal(await count(pool, 'SELECT COUNT(*)::int n FROM product_demo_step_images WHERE step_id=$1', [step.id]), 2);
    const more = await upload(admin, `/admin/demo-steps/${step.id}/images`, {}, [3, 4].map(i => ['images', PNG, `s${i}.png`, 'image/png']), editUrl(plugin.id));
    assert.equal(more.status, 302);
    assert.equal(await count(pool, 'SELECT COUNT(*)::int n FROM product_demo_step_images WHERE step_id=$1', [step.id]), 4);
    const page = await new Client(srv.base).get(`/shop/${plugin.slug}`);
    assert.match(page.text, /QA-TEST پارت ۱ — نصب/);
    assert.equal((page.text.match(/<div class="demo-step-images is-multi">/g) || []).length, 1);
    assert.equal((page.text.match(/alt="QA-TEST پارت ۱ — نصب — \d"/g) || []).length, 4, 'all four images of the part are shown');
    const img = (await pool.query('SELECT id FROM product_demo_step_images WHERE step_id=$1 ORDER BY id LIMIT 1', [step.id])).rows[0];
    await admin.postWithCsrf(`/admin/demo-step-images/${img.id}/delete`, {}, editUrl(plugin.id));
    assert.equal(await count(pool, 'SELECT COUNT(*)::int n FROM product_demo_step_images WHERE step_id=$1', [step.id]), 3);
    const form = await admin.get(editUrl(plugin.id));
    assert.match(form.text, /پارت‌های آموزش نحوهٔ کار با افزونه/);
    assert.match(form.text, new RegExp(`action="/admin/demo-steps/${step.id}/images"`));
    await admin.postWithCsrf(`/admin/demo-steps/${step.id}/delete`, {}, editUrl(plugin.id));
    assert.equal(await count(pool, 'SELECT COUNT(*)::int n FROM product_demo_step_images WHERE step_id=$1', [step.id]), 0, 'deleting a part removes its images');
  });

  await t.test('course video parts: uploaded together, numbered after existing parts, only the first may be a preview', async () => {
    const r = await upload(admin, `/admin/products/${course.id}/assets`, { asset_title: 'فصل اول', asset_kind: 'video', is_preview: 'on' },
      [1, 2, 3].map(i => ['assetFiles', MP4, `p${i}.mp4`, 'video/mp4']), editUrl(course.id));
    assert.equal(r.status, 302);
    await upload(admin, `/admin/products/${course.id}/assets`, { asset_title: 'فصل دوم', asset_kind: 'video' },
      [4, 5].map(i => ['assetFiles', MP4, `p${i}.mp4`, 'video/mp4']), editUrl(course.id));
    const rows = (await pool.query('SELECT title, is_preview FROM product_assets WHERE product_id=$1 ORDER BY sort_order,id', [course.id])).rows;
    assert.deepEqual(rows.map(r => r.title), ['فصل اول – قسمت 1', 'فصل اول – قسمت 2', 'فصل اول – قسمت 3', 'فصل دوم – قسمت 4', 'فصل دوم – قسمت 5']);
    assert.deepEqual(rows.map(r => r.is_preview), [true, false, false, false, false]);
    const page = await new Client(srv.base).get(`/shop/${course.slug}`);
    for (const r of rows) assert.ok(page.text.includes(r.title), `${r.title} listed on the course page`);
    assert.match((await admin.get(editUrl(course.id))).text, /قسمت‌های دوره \(ویدیو\) و فایل‌ها/);
  });

  await t.test('one wrong file in a batch rejects the whole batch; too many files gives a clear message', async () => {
    const before = await count(pool, 'SELECT COUNT(*)::int n FROM product_assets WHERE product_id=$1', [course.id]);
    await upload(admin, `/admin/products/${course.id}/assets`, { asset_title: 'جعلی', asset_kind: 'video' },
      [['assetFiles', MP4, 'ok.mp4', 'video/mp4'], ['assetFiles', PNG, 'fake.mp4', 'video/mp4']], editUrl(course.id));
    assert.equal(await count(pool, 'SELECT COUNT(*)::int n FROM product_assets WHERE product_id=$1', [course.id]), before);
    const many = await upload(admin, `/admin/products/${plugin.id}/gallery`, {}, Array.from({ length: 13 }, (_, i) => ['images', PNG, `x${i}.png`, 'image/png']), editUrl(plugin.id));
    assert.equal(many.status, 400);
    assert.match(many.text, /حداکثر 12 فایل/);
  });

  await t.test('a single file with the older field names still works', async () => {
    const r = await upload(admin, `/admin/products/${plugin.id}/gallery`, {}, [['image', PNG, 'old.png', 'image/png']], editUrl(plugin.id));
    assert.equal(r.status, 302);
    const a = await upload(admin, `/admin/products/${plugin.id}/assets`, { asset_title: 'فایل نصب', asset_kind: 'download' }, [['assetFile', Buffer.from('PK\x03\x04' + 'x'.repeat(60)), 'setup.zip', 'application/zip']], editUrl(plugin.id));
    assert.equal(a.status, 302);
    assert.equal(await count(pool, "SELECT COUNT(*)::int n FROM product_assets WHERE product_id=$1 AND title='فایل نصب'", [plugin.id]), 1);
  });
});
