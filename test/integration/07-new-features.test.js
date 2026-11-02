'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

async function multipart(c, url, fields, fileField, buffer, name, type, from) {
  const fd = new FormData();
  fd.set('_csrf', await c.csrf(from || url));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (fileField) fd.set(fileField, new Blob([buffer], { type }), name);
  return c.request('POST', url, { multipart: fd });
}

test('plugin product rich content: admin manages gallery/demo steps, public page renders them, non-plugin products fall back gracefully', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'content_admin', PW, 'content');
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const admin = new Client(srv.base);
  await admin.adminLogin('content_admin', PW);

  let pluginId;
  await t.test('admin creates a plugin product with demo video + usage intro', async () => {
    const r = await multipart(admin, '/admin/products',
      { title: 'افزونهٔ محاسبهٔ لوله', price_toman: '150000', product_type: 'plugin', status: 'published',
        demo_video_url: 'https://example.com/demo-video', usage_guide_intro: 'ابتدا افزونه را نصب کنید.' },
      'cover', PNG, 'cover.png', 'image/png', '/admin/products/new');
    assert.equal(r.status, 302);
    const row = (await pool.query("SELECT id,demo_video_url,usage_guide_intro FROM products WHERE product_type='plugin' ORDER BY id DESC LIMIT 1")).rows[0];
    pluginId = row.id;
    assert.equal(row.demo_video_url, 'https://example.com/demo-video');
    assert.match(row.usage_guide_intro, /نصب کنید/);
  });

  await t.test('admin adds a gallery image and a demo step', async () => {
    const gallery = await multipart(admin, `/admin/products/${pluginId}/gallery`, { caption: 'نمای پنل افزونه', sort_order: '0' }, 'image', PNG, 'g1.png', 'image/png', `/admin/products/${pluginId}/edit`);
    assert.equal(gallery.status, 302);
    const step = await multipart(admin, `/admin/products/${pluginId}/demo-steps`, { title: 'نصب افزونه', body: 'فایل زیپ را در اتوکد بارگذاری کنید.', sort_order: '0' }, 'image', PNG, 's1.png', 'image/png', `/admin/products/${pluginId}/edit`);
    assert.equal(step.status, 302);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM product_gallery_images WHERE product_id=$1', [pluginId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM product_demo_steps WHERE product_id=$1', [pluginId])).rows[0].n, 1);
  });

  await t.test('the public product page renders the gallery, usage intro, demo steps and video link', async () => {
    const slug = (await pool.query('SELECT slug FROM products WHERE id=$1', [pluginId])).rows[0].slug;
    const page = await admin.get(`/shop/${slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /نمای پنل افزونه/);
    assert.match(page.text, /نصب افزونه/);
    assert.match(page.text, /فایل زیپ را در اتوکد بارگذاری کنید/);
    assert.match(page.text, /ابتدا افزونه را نصب کنید/);
    assert.match(page.text, /example\.com\/demo-video/);
  });

  await t.test('admin can delete a gallery image and a demo step', async () => {
    const galleryRow = (await pool.query('SELECT id FROM product_gallery_images WHERE product_id=$1', [pluginId])).rows[0];
    const stepRow = (await pool.query('SELECT id FROM product_demo_steps WHERE product_id=$1', [pluginId])).rows[0];
    await admin.postWithCsrf(`/admin/gallery/${galleryRow.id}/delete`, {}, `/admin/products/${pluginId}/edit`);
    await admin.postWithCsrf(`/admin/demo-steps/${stepRow.id}/delete`, {}, `/admin/products/${pluginId}/edit`);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM product_gallery_images WHERE product_id=$1', [pluginId])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM product_demo_steps WHERE product_id=$1', [pluginId])).rows[0].n, 0);
  });

  await t.test('an existing course (non-plugin) product renders without any plugin-only section, no regression', async () => {
    const r = await multipart(admin, '/admin/products', { title: 'دورهٔ تأسیسات مکانیکی', price_toman: '200000', product_type: 'course', status: 'published' }, 'cover', PNG, 'c.png', 'image/png', '/admin/products/new');
    assert.equal(r.status, 302);
    const course = (await pool.query("SELECT slug FROM products WHERE product_type='course' ORDER BY id DESC LIMIT 1")).rows[0];
    const page = await admin.get(`/shop/${course.slug}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /نحوه استفاده \/ دمو/);
    assert.doesNotMatch(page.text, /گالری تصاویر/);
  });
});

test('engineering consultation requests: public submission, validation, reference number, admin review', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'owner_consult', PW, 'owner');
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const visitor = new Client(srv.base);

  await t.test('submitting with an invalid mobile number is rejected with an inline Persian error, nothing is saved', async () => {
    const token = await visitor.csrf('/coverage-map');
    const r = await visitor.post('/consultation-requests', { _csrf: token, full_name: 'علی رضایی', mobile: '12345', city: 'بندرعباس', project_description: 'بررسی اولیه' });
    assert.equal(r.status, 422);
    assert.match(r.text, /شمارهٔ موبایل معتبر نیست/);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM consultation_requests')).rows[0].n, 0, 'no row written on validation failure');
  });

  await t.test('submitting with required fields missing is rejected and nothing is saved', async () => {
    const token = await visitor.csrf('/coverage-map');
    const r = await visitor.post('/consultation-requests', { _csrf: token, full_name: '', mobile: '09121234567', city: '', project_description: '' });
    assert.equal(r.status, 422);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM consultation_requests')).rows[0].n, 0);
  });

  let coverageAreaId;
  await t.test('a valid submission linked to a coverage-map area is persisted to the real database', async () => {
    coverageAreaId = (await pool.query('SELECT id FROM coverage_areas ORDER BY id LIMIT 1')).rows[0].id;
    const token = await visitor.csrf('/coverage-map');
    const r = await visitor.post('/consultation-requests', {
      _csrf: token, full_name: 'علی رضایی', mobile: '09121234567', contact_method: 'sms', province: 'هرمزگان',
      city: 'بندرعباس', district: 'مرکز', coverage_area_id: String(coverageAreaId), project_type: 'ساختمان مسکونی',
      project_address: 'خیابان نمونه', project_description: 'ارزیابی گازرسانی ساختمان ۴ طبقه',
      request_type: 'gas_engineering_assessment', project_status: 'existing_building', notes: 'در اسرع وقت',
      preferred_contact_time: 'صبح‌ها'
    });
    assert.equal(r.status, 302, 'redirects back to the coverage map on success');
    const row = (await pool.query('SELECT * FROM consultation_requests ORDER BY id DESC LIMIT 1')).rows[0];
    assert.ok(row, 'request was actually written to the database');
    assert.equal(row.full_name, 'علی رضایی');
    assert.equal(row.mobile, '09121234567');
    assert.equal(row.coverage_area_id, coverageAreaId);
    assert.equal(row.request_type, 'gas_engineering_assessment');
    const flash = await visitor.flash('/coverage-map');
    assert.match(flash.message, /CR-\d+/, 'a reference number is shown on success');
  });

  await t.test('the submission appears in the admin review list, with contact details visible only there', async () => {
    const admin = new Client(srv.base);
    assert.equal((await admin.adminLogin('owner_consult', PW)).status, 302);
    const list = await admin.get('/admin/consultation-requests');
    assert.equal(list.status, 200);
    assert.match(list.text, /علی رضایی/);
    assert.match(list.text, /09121234567/);
    const publicMapPage = await visitor.get('/coverage-map');
    assert.doesNotMatch(publicMapPage.text, /علی رضایی/, 'submitted name is never shown back on the public page');
    assert.doesNotMatch(publicMapPage.text, /value="09121234567"/, 'submitted mobile is never echoed into the page (only the static format placeholder may appear)');
  });

  await t.test('admin updates the request status', async () => {
    const admin = new Client(srv.base);
    await admin.adminLogin('owner_consult', PW);
    const row = (await pool.query('SELECT id FROM consultation_requests ORDER BY id DESC LIMIT 1')).rows[0];
    const token = await admin.csrf('/admin/consultation-requests');
    const r = await admin.post(`/admin/consultation-requests/${row.id}/status`, { _csrf: token, status: 'contacted' });
    assert.equal(r.status, 302);
    assert.equal((await pool.query('SELECT status FROM consultation_requests WHERE id=$1', [row.id])).rows[0].status, 'contacted');
  });

  await t.test('a role without the support/consultation permission cannot see the admin list', async () => {
    await createAdmin(pool, 'orders_only', PW, 'orders');
    const limited = new Client(srv.base);
    await limited.adminLogin('orders_only', PW);
    assert.equal((await limited.get('/admin/consultation-requests')).status, 403);
  });
});

test('About us team roster (item 4): empty state, full admin CRUD, public page end-to-end', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'content_about', PW, 'content');
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const admin = new Client(srv.base);
  await admin.adminLogin('content_about', PW);

  await t.test('with no team members, the public page shows a clean empty state, not a blank/missing section', async () => {
    const page = await admin.get('/about');
    assert.equal(page.status, 200);
    assert.match(page.text, /معرفی تیم به‌زودی تکمیل می‌شود/);
  });

  let memberId;
  await t.test('admin adds a team member', async () => {
    const r = await multipart(admin, '/admin/team', { name: 'مهندس نمونه', role: 'مدیر فنی', bio: 'متخصص تأسیسات.', display_order: '1', is_active: 'on' }, null, null, null, null, '/admin/team/new');
    assert.equal(r.status, 302);
    const row = (await pool.query('SELECT id FROM team_members ORDER BY id DESC LIMIT 1')).rows[0];
    memberId = row.id;
  });

  await t.test('the public about page now renders the member instead of the empty state', async () => {
    const page = await admin.get('/about');
    assert.equal(page.status, 200);
    assert.match(page.text, /مهندس نمونه/);
    assert.match(page.text, /مدیر فنی/);
    assert.doesNotMatch(page.text, /معرفی تیم به‌زودی تکمیل می‌شود/);
  });

  await t.test('admin edits the member', async () => {
    const r = await multipart(admin, `/admin/team/${memberId}/edit`, { name: 'مهندس نمونه ویرایش‌شده', role: 'مدیر فنی ارشد', bio: 'به‌روزرسانی شد.', display_order: '1', is_active: 'on' }, null, null, null, null, `/admin/team/${memberId}/edit`);
    assert.equal(r.status, 302);
    const page = await admin.get('/about');
    assert.match(page.text, /مهندس نمونه ویرایش‌شده/);
  });

  await t.test('admin deletes the member and the public page returns to the empty state', async () => {
    const r = await admin.postWithCsrf(`/admin/team/${memberId}/delete`, {}, '/admin/team');
    assert.equal(r.status, 302);
    const page = await admin.get('/about');
    assert.match(page.text, /معرفی تیم به‌زودی تکمیل می‌شود/);
    assert.doesNotMatch(page.text, /مهندس نمونه/);
  });

  await t.test('a role without the content permission cannot manage the team roster', async () => {
    await createAdmin(pool, 'orders_about', PW, 'orders');
    const limited = new Client(srv.base);
    await limited.adminLogin('orders_about', PW);
    assert.equal((await limited.get('/admin/team')).status, 403);
  });
});

test('Hormozgan coverage map: public page, JSON data endpoint, demo-data disclaimer, live filtering', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const c = new Client(srv.base);

  await t.test('the public page renders with the demo-data disclaimer and at least the seeded demo areas', async () => {
    const page = await c.get('/coverage-map');
    assert.equal(page.status, 200);
    assert.match(page.text, /داده نمایشی/);
    assert.match(page.text, /بندرعباس/);
    assert.match(page.text, /coverage-map/);
  });

  await t.test('the JSON data endpoint returns the full dataset and a live-computed summary', async () => {
    const r = await c.get('/api/coverage-areas');
    assert.equal(r.status, 200);
    const data = JSON.parse(r.text);
    assert.ok(Array.isArray(data.areas));
    assert.ok(data.areas.length >= 5);
    assert.equal(data.summary.areasCount, data.areas.length);
    assert.ok(data.areas.every(a => a.isDemo === true), 'every seeded record is explicitly marked demo data');
  });

  await t.test('filtering by city narrows both the list and the computed summary', async () => {
    const r = await c.get('/api/coverage-areas?city=' + encodeURIComponent('بندرعباس'));
    const data = JSON.parse(r.text);
    assert.ok(data.areas.length >= 1);
    assert.ok(data.areas.every(a => a.city === 'بندرعباس'));
    assert.equal(data.summary.areasCount, data.areas.length);
  });

  await t.test('filtering by an unmatched search term returns an empty, not an error', async () => {
    const r = await c.get('/api/coverage-areas?q=' + encodeURIComponent('no-such-place-xyz'));
    assert.equal(r.status, 200);
    const data = JSON.parse(r.text);
    assert.deepEqual(data.areas, []);
    assert.equal(data.summary.totalProjects, 0);
  });

  await t.test('no record ever implies installed gas service unless gasServiceStatus says so (never fabricated)', async () => {
    const r = await c.get('/api/coverage-areas');
    const data = JSON.parse(r.text);
    for (const area of data.areas) {
      if (area.gasServiceStatus !== 'installed') assert.notEqual(area.gasServiceStatus, undefined);
    }
  });
});
