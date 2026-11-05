'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipReason, newPool, resetDatabase } = require('./helpers');
const { migrateUp, migrateDown, status, listMigrations } = require('../../src/lib/migrations');

test('migrations on PostgreSQL', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  t.after(() => pool.end());

  const ALL_MIGRATIONS = ['0001_baseline', '0002_hardening', '0003_team_members', '0004_bilingual_content', '0005_support_tickets',
    '0006_brand_rename', '0007_plugin_content', '0008_coverage_map', '0009_consultation_requests', '0010_about_text_brand', '0011_demo_step_images'];

  await t.test('fresh database: all migrations apply, re-run is a no-op', async () => {
    await resetDatabase(pool);
    const ran = await migrateUp(pool);
    assert.deepEqual(ran, ALL_MIGRATIONS);
    assert.deepEqual(await migrateUp(pool), []);
    const tables = (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map(r => r.table_name);
    for (const t of ['users', 'products', 'orders', 'admin_accounts', 'admin_audit_logs', 'rate_limit_hits', 'web_sessions', 'schema_migrations', 'team_members', 'tickets', 'ticket_messages',
      'product_gallery_images', 'product_demo_steps', 'coverage_areas', 'consultation_requests']) assert.ok(tables.includes(t), t);
    const productColumns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='products'")).rows.map(r => r.column_name);
    for (const c of ['title_en', 'subtitle_en', 'short_description_en', 'description_en', 'demo_video_url', 'usage_guide_intro']) assert.ok(productColumns.includes(c), c);
    assert.equal((await pool.query("SELECT setting_value FROM site_settings WHERE setting_key='site_name'")).rows[0].setting_value, 'Novingity', 'brand rename applied on fresh install');
    const demoAreas = (await pool.query('SELECT COUNT(*)::int n FROM coverage_areas WHERE is_demo')).rows[0].n;
    assert.ok(demoAreas >= 5, 'demo coverage-map seed data present');
    const s = await status(pool);
    assert.ok(s.every(m => m.applied && !m.checksumMismatch));
  });

  await t.test('legacy database created by the old schema.sql runner upgrades without data loss', async () => {
    await resetDatabase(pool);
    // Simulate v2: the old runner executed schema.sql directly, with no schema_migrations table.
    await pool.query(listMigrations()[0].sql);
    // Legacy data including a pre-admin_accounts administrator (admin_credentials) that must be preserved.
    await pool.query("INSERT INTO users(phone,first_name,role) VALUES('09120000001','قدیمی','user'),('09120000002','مدیر قدیمی','admin')");
    await pool.query("INSERT INTO products(slug,title,product_type,price_toman,status) VALUES('p1','محصول','course',1000,'published')");
    await pool.query("INSERT INTO site_settings(setting_key,setting_value) VALUES('site_name','نام سفارشی') ON CONFLICT (setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value");
    const before = (await pool.query('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM products) p')).rows[0];
    const ran = await migrateUp(pool);
    assert.deepEqual(ran, ALL_MIGRATIONS, 'baseline is idempotent on a legacy database');
    const after = (await pool.query('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM products) p')).rows[0];
    assert.deepEqual(after, before);
    assert.equal((await pool.query("SELECT setting_value FROM site_settings WHERE setting_key='site_name'")).rows[0].setting_value, 'نام سفارشی', 'custom site name preserved');
  });

  await t.test('rollback of 0011-0002 is reversible and keeps user data', async () => {
    await pool.query("INSERT INTO rate_limit_hits(key_hash) VALUES(repeat('a',64))");
    await pool.query("INSERT INTO team_members(name) VALUES('نمونه')");
    // Only the most recently applied migration can be rolled back; roll them off in reverse order.
    const about = async () => (await pool.query("SELECT setting_value v FROM site_settings WHERE setting_key='about_text'")).rows[0]?.v;
    const aboutAfter = await about();
    assert.equal(await migrateDown(pool, '0011'), '0011_demo_step_images');
    assert.equal((await pool.query("SELECT to_regclass('public.product_demo_step_images') AS t")).rows[0].t, null);
    assert.equal(await migrateDown(pool, '0010'), '0010_about_text_brand');
    if (aboutAfter && aboutAfter.startsWith('Novingity بستری')) assert.match(await about(), /^Nogiti بستری/, '0010 down restores the old default');
    assert.equal(await migrateDown(pool, '0009'), '0009_consultation_requests');
    assert.equal((await pool.query("SELECT to_regclass('public.consultation_requests') AS t")).rows[0].t, null);
    assert.equal(await migrateDown(pool, '0008'), '0008_coverage_map');
    assert.equal((await pool.query("SELECT to_regclass('public.coverage_areas') AS t")).rows[0].t, null);
    assert.equal(await migrateDown(pool, '0007'), '0007_plugin_content');
    assert.equal((await pool.query("SELECT to_regclass('public.product_demo_steps') AS t")).rows[0].t, null);
    assert.equal(await migrateDown(pool, '0006'), '0006_brand_rename');
    assert.equal(await migrateDown(pool, '0005'), '0005_support_tickets');
    assert.equal((await pool.query("SELECT to_regclass('public.tickets') AS t")).rows[0].t, null);
    assert.equal(await migrateDown(pool, '0004'), '0004_bilingual_content');
    assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='title_en'")).rowCount, 0);
    assert.equal(await migrateDown(pool, '0003'), '0003_team_members');
    assert.equal((await pool.query("SELECT to_regclass('public.team_members') AS t")).rows[0].t, null);
    const name = await migrateDown(pool, '0002');
    assert.equal(name, '0002_hardening');
    assert.equal((await pool.query("SELECT to_regclass('public.rate_limit_hits') AS t")).rows[0].t, null);
    assert.equal(Number((await pool.query('SELECT COUNT(*) n FROM users')).rows[0].n), 2);
    await assert.rejects(migrateDown(pool, '0001'), /no reviewed \.down\.sql|Only the most recently applied/);
    assert.deepEqual(await migrateUp(pool), ['0002_hardening', '0003_team_members', '0004_bilingual_content', '0005_support_tickets',
      '0006_brand_rename', '0007_plugin_content', '0008_coverage_map', '0009_consultation_requests', '0010_about_text_brand', '0011_demo_step_images']);
  });

  await t.test('0010 renames the brand only in the untouched default About text', async () => {
    assert.equal(await migrateDown(pool, '0011'), '0011_demo_step_images');
    assert.equal(await migrateDown(pool, '0010'), '0010_about_text_brand');
    await pool.query("UPDATE site_settings SET setting_value='Nogiti — متن نوشته‌شده توسط مدیر' WHERE setting_key='about_text'");
    await migrateUp(pool);
    assert.equal((await pool.query("SELECT setting_value v FROM site_settings WHERE setting_key='about_text'")).rows[0].v, 'Nogiti — متن نوشته‌شده توسط مدیر', 'admin-written text is never overwritten');
  });

  await t.test('an edited, already-applied migration is detected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogiti-mig-'));
    for (const m of listMigrations()) fs.writeFileSync(path.join(dir, m.file), m.sql + (m.version === '0002' ? '\n-- edited' : ''));
    await assert.rejects(migrateUp(pool, { dir }), /checksum mismatch/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('concurrent migrators serialise on the advisory lock', async () => {
    await resetDatabase(pool);
    const results = await Promise.all([migrateUp(pool), migrateUp(pool), migrateUp(pool)]);
    assert.equal(results.flat().length, ALL_MIGRATIONS.length, 'each migration applied exactly once');
  });
});
