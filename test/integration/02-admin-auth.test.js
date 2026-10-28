'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const OWNER = ['owner_one', 'Owner-Password-2026!'];

test('admin authentication, sessions and request integrity', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, ...OWNER, 'owner');
  let srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });

  await t.test('anonymous visitors cannot reach admin pages', async () => {
    const c = new Client(srv.base);
    for (const url of ['/admin', '/admin/products', '/admin/admins', '/admin/audit', '/admin/settings']) {
      assert.equal((await c.get(url)).status, 403, url);
    }
    assert.equal((await c.postWithCsrf('/admin/settings', { site_name: 'hack' }, '/admin/login')).status, 403);
    const login = await c.get('/admin/login');
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('cache-control'), 'no-store, private, max-age=0');
  });

  await t.test('successful login regenerates the session and is audited', async () => {
    const c = new Client(srv.base);
    await c.get('/admin/login');
    const before = c.cookies.get('nugas.sid');
    const r = await c.adminLogin(...OWNER);
    assert.equal(r.status, 302);
    assert.equal(r.location, '/admin');
    assert.notEqual(c.cookies.get('nugas.sid'), before, 'session id rotated (fixation protection)');
    assert.equal((await c.get('/admin')).status, 200);
    const audit = await pool.query("SELECT action FROM admin_audit_logs WHERE action='admin.login.success'");
    assert.equal(audit.rowCount, 1);
  });

  await t.test('failed logins show a generic message and are audited without secrets', async () => {
    const c = new Client(srv.base);
    await c.adminLogin('owner_one', 'wrong-password-123');
    assert.match((await c.flash('/admin/login')).message, /نام کاربری یا گذرواژه مدیر صحیح نیست/);
    await c.adminLogin('nobody_here', 'wrong-password-123');
    assert.match((await c.flash('/admin/login')).message, /نام کاربری یا گذرواژه مدیر صحیح نیست/, 'unknown user gets the same message');
    const rows = (await pool.query("SELECT * FROM admin_audit_logs WHERE action='admin.login.failure'")).rows;
    assert.equal(rows.length, 2);
    assert.doesNotMatch(JSON.stringify(rows), /wrong-password/);
  });

  await t.test('8 failures lock the account even with the right password; lock survives an app restart', async () => {
    await pool.query('DELETE FROM rate_limit_hits');
    await createAdmin(pool, 'locked_admin', 'Locked-Password-2026!', 'admin');
    const c = new Client(srv.base);
    for (let i = 0; i < 8; i++) await c.adminLogin('locked_admin', `bad-password-${i}xx`);
    const r = await c.adminLogin('locked_admin', 'Locked-Password-2026!');
    assert.equal(r.location, '/admin/login', 'correct password refused while locked');
    assert.match((await c.flash('/admin/login')).message, /موقتاً مسدود/);
    assert.equal((await pool.query("SELECT COUNT(*)::int n FROM admin_audit_logs WHERE action='admin.login.locked'")).rows[0].n, 1);
    // Simulate a deploy/restart: durable counter, not process memory.
    await srv.stop();
    srv = await startApp({ pool, uploadDir: srv.uploadDir });
    const c2 = new Client(srv.base);
    await c2.adminLogin('locked_admin', 'Locked-Password-2026!');
    assert.match((await c2.flash('/admin/login')).message, /موقتاً مسدود/);
    // Other accounts are unaffected by this username's lock.
    assert.equal((await new Client(srv.base).adminLogin(...OWNER)).location, '/admin');
    // Window expiry: age the hits beyond 15 minutes -> login works again and the counter is cleared.
    await pool.query("UPDATE rate_limit_hits SET hit_at = hit_at - INTERVAL '16 minutes'");
    assert.equal((await new Client(srv.base).adminLogin('locked_admin', 'Locked-Password-2026!')).location, '/admin');
    const hashes = (await pool.query('SELECT key_hash FROM rate_limit_hits')).rows.map(r => r.key_hash);
    assert.ok(hashes.every(h => /^[0-9a-f]{64}$/.test(h)), 'only HMAC digests are stored, never usernames or IPs');
  });

  await t.test('a parallel burst of wrong passwords cannot exceed the 8-attempt limit (atomic reserve)', async () => {
    await pool.query('DELETE FROM rate_limit_hits');
    await createAdmin(pool, 'burst_admin', 'Burst-Password-2026!', 'admin');
    // 25 independent clients fire at once; with a check-then-record sequence most of them would get through.
    const clients = await Promise.all(Array.from({ length: 25 }, async () => {
      const c = new Client(srv.base);
      return { c, token: await c.csrf('/admin/login') };
    }));
    await Promise.all(clients.map(({ c, token }, i) => c.post('/admin/login', { _csrf: token, username: 'burst_admin', password: `burst-wrong-${i}-xx` })));
    const failures = (await pool.query("SELECT COUNT(*)::int n FROM admin_audit_logs l JOIN admin_accounts a ON a.id=l.admin_account_id WHERE a.username='burst_admin' AND l.action='admin.login.failure'")).rows[0].n;
    assert.equal(failures, 8, 'exactly 8 password checks happened; the rest were refused before bcrypt ran');
    const locked = (await pool.query("SELECT COUNT(*)::int n FROM admin_audit_logs WHERE action='admin.login.locked'")).rows[0].n;
    assert.ok(locked >= 17, `remaining requests were refused as locked (got ${locked})`);
    await pool.query('DELETE FROM rate_limit_hits');
  });

  await t.test('inactive administrators cannot log in', async () => {
    await createAdmin(pool, 'disabled_admin', 'Disabled-Password-2026!', 'admin', false);
    const r = await new Client(srv.base).adminLogin('disabled_admin', 'Disabled-Password-2026!');
    assert.equal(r.location, '/admin/login');
  });

  await t.test('logout destroys the session server-side', async () => {
    const c = new Client(srv.base);
    await c.adminLogin(...OWNER);
    const sid = c.cookies.get('nugas.sid');
    const r = await c.postWithCsrf('/admin/logout', {}, '/admin');
    assert.equal(r.location, '/admin/login');
    assert.equal((await c.get('/admin')).status, 403);
    // Replaying the old cookie must not work either.
    const replay = new Client(srv.base);
    replay.cookies.set('nugas.sid', sid);
    assert.equal((await replay.get('/admin')).status, 403);
    assert.ok((await pool.query("SELECT 1 FROM admin_audit_logs WHERE action='admin.logout'")).rowCount >= 1);
  });

  await t.test('idle (2h) and absolute (12h) admin session expiry', async () => {
    for (const field of ['adminLastActivity', 'adminSessionStartedAt']) {
      const c = new Client(srv.base);
      await c.adminLogin(...OWNER);
      const sid = decodeURIComponent(c.cookies.get('nugas.sid')).slice(2).split('.')[0];
      const age = field === 'adminLastActivity' ? 2 * 3600 * 1000 + 60000 : 12 * 3600 * 1000 + 60000;
      await pool.query(`UPDATE web_sessions SET sess = jsonb_set(sess::jsonb, '{${field}}', to_jsonb($2::bigint))::json WHERE sid=$1`, [sid, Date.now() - age]);
      const r = await c.get('/admin');
      assert.equal(r.status, 401, field);
      assert.match(r.text, /نشست منقضی شد/);
      assert.equal((await c.get('/admin')).status, 403, 'session is gone afterwards');
    }
  });

  await t.test('CSRF: missing/invalid tokens and cross-origin requests are rejected', async () => {
    const c = new Client(srv.base);
    await c.adminLogin(...OWNER);
    assert.equal((await c.post('/admin/settings', { site_name: 'x' })).status, 403, 'no token');
    assert.equal((await c.post('/admin/settings', { _csrf: 'forged', site_name: 'x' })).status, 403, 'wrong token');
    const token = await c.csrf('/admin/settings');
    const cross = await c.post('/admin/settings', { _csrf: token, site_name: 'x' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403, 'valid token but foreign Origin');
    const same = await c.post('/admin/settings', { _csrf: token, site_name: 'Nogiti', contact_email: 'a@b.ir' }, { headers: { origin: srv.base } });
    assert.equal(same.status, 302, 'same-origin request accepted');
  });

  await t.test('cross-origin multipart upload is rejected before any file is written', async () => {
    const c = new Client(srv.base);
    await c.adminLogin(...OWNER);
    const before = fs.readdirSync(`${srv.uploadDir}/covers`).length;
    const fd = new FormData();
    fd.set('_csrf', await c.csrf('/admin/products/new'));
    fd.set('title', 'x'); fd.set('price_toman', '1000');
    fd.set('cover', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'a.png');
    const r = await c.request('POST', '/admin/products', { multipart: fd, headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    const fd2 = new FormData();
    fd2.set('_csrf', 'forged'); fd2.set('title', 'x'); fd2.set('price_toman', '1000');
    fd2.set('cover', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'a.png');
    assert.equal((await c.request('POST', '/admin/products', { multipart: fd2 })).status, 403);
    assert.equal(fs.readdirSync(`${srv.uploadDir}/covers`).length, before, 'no orphaned upload left on disk');
  });

  await t.test('security headers are present', async () => {
    const r = await new Client(srv.base).get('/');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    assert.doesNotMatch(r.headers.get('content-security-policy'), /jsdelivr/, 'font is self-hosted');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('x-request-id'));
    assert.equal(r.headers.get('x-powered-by'), null);
  });
});
