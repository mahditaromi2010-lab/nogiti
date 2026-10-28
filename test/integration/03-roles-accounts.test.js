'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';

test('roles are enforced server-side and admin accounts are managed safely', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  const ownerId = await createAdmin(pool, 'owner_one', PW, 'owner');
  for (const role of ['admin', 'content', 'orders', 'users']) await createAdmin(pool, `${role}_mgr`, PW, role);
  await pool.query("INSERT INTO products(slug,title,product_type,price_toman,status) VALUES('p1','محصول ۱','course',1000,'published')");
  await pool.query("INSERT INTO product_assets(product_id,title,asset_kind,external_url) VALUES(1,'درس','link','https://example.com/v')");
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });
  const login = async user => { const c = new Client(srv.base); const r = await c.adminLogin(user, PW); assert.equal(r.status, 302, user); return c; };

  await t.test('GET access matrix per role', async () => {
    const matrix = {
      owner_one: { '/admin': 200, '/admin/products': 200, '/admin/orders': 200, '/admin/users': 200, '/admin/settings': 200, '/admin/audit': 200, '/admin/admins': 200, '/admin/account': 200 },
      admin_mgr: { '/admin': 200, '/admin/products': 200, '/admin/orders': 200, '/admin/users': 200, '/admin/settings': 200, '/admin/audit': 200, '/admin/admins': 403, '/admin/account': 200 },
      content_mgr: { '/admin': 302, '/admin/products': 200, '/admin/articles': 200, '/admin/orders': 403, '/admin/users': 403, '/admin/settings': 403, '/admin/audit': 403, '/admin/admins': 403, '/admin/account': 200 },
      orders_mgr: { '/admin': 302, '/admin/orders': 200, '/admin/products': 403, '/admin/users': 403, '/admin/settings': 403, '/admin/admins': 403 },
      users_mgr: { '/admin': 302, '/admin/users': 200, '/admin/orders': 403, '/admin/products': 403, '/admin/audit': 403 }
    };
    for (const [user, routes] of Object.entries(matrix)) {
      const c = await login(user);
      for (const [url, expected] of Object.entries(routes)) assert.equal((await c.get(url)).status, expected, `${user} GET ${url}`);
    }
  });

  await t.test('state-changing requests are refused for roles without the permission (UI hiding is not relied on)', async () => {
    const content = await login('content_mgr');
    const token = await content.csrf('/admin/products');
    assert.equal((await content.post('/admin/settings', { _csrf: token, site_name: 'pwn' })).status, 403);
    assert.equal((await content.post('/admin/users/1/toggle', { _csrf: token })).status, 403);
    assert.equal((await content.post('/admin/admins/create', { _csrf: token, username: 'x_new', password: PW, role: 'owner' })).status, 403);
    const orders = await login('orders_mgr');
    const t2 = await orders.csrf('/admin/orders');
    assert.equal((await orders.post('/admin/products/1/delete', { _csrf: t2 })).status, 403);
    assert.equal((await orders.post('/admin/assets/1/delete', { _csrf: t2 })).status, 403);
    const admin = await login('admin_mgr');
    const t3 = await admin.csrf('/admin');
    assert.equal((await admin.post('/admin/admins/create', { _csrf: t3, username: 'sneaky', password: PW, role: 'owner' })).status, 403, 'admin role cannot create owners');
    assert.equal((await pool.query("SELECT 1 FROM admin_accounts WHERE username IN ('x_new','sneaky')")).rowCount, 0);
    assert.equal((await pool.query("SELECT status FROM products WHERE id=1")).rows[0].status, 'published');
  });

  await t.test('content role can manage assets (previously blocked by the permission map)', async () => {
    const content = await login('content_mgr');
    const nav = await content.get('/admin/products');
    assert.doesNotMatch(nav.text, /href="\/admin\/orders"/, 'nav hides sections the role cannot use');
    const r = await content.postWithCsrf('/admin/assets/1/delete', {}, '/admin/products/1/edit');
    assert.equal(r.location, '/admin/products/1/edit');
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM product_assets')).rows[0].n, 0);
  });

  await t.test('owner creates an administrator; weak passwords and duplicates are refused', async () => {
    const owner = await login('owner_one');
    await owner.postWithCsrf('/admin/admins/create', { username: 'Editor.Two', password: 'short', role: 'content' }, '/admin/admins');
    assert.match((await owner.flash('/admin/admins')).message, /۱۲ تا ۲۰۰/);
    await owner.postWithCsrf('/admin/admins/create', { username: 'editor.two', password: 'editor.two-is-my-password', role: 'content' }, '/admin/admins');
    assert.match((await owner.flash('/admin/admins')).message, /نام کاربری/);
    await owner.postWithCsrf('/admin/admins/create', { username: 'Editor.Two', password: PW, role: 'content' }, '/admin/admins');
    assert.match((await owner.flash('/admin/admins')).message, /ساخته شد/);
    await owner.postWithCsrf('/admin/admins/create', { username: 'editor.two', password: PW, role: 'content' }, '/admin/admins');
    assert.match((await owner.flash('/admin/admins')).message, /قبلاً ثبت شده/);
    const row = (await pool.query("SELECT role,password_hash,created_by FROM admin_accounts WHERE username='editor.two'")).rows[0];
    assert.equal(row.role, 'content');
    assert.equal(Number(row.created_by), Number(ownerId));
    assert.match(row.password_hash, /^\$2[aby]\$12\$/, 'bcrypt cost 12');
    assert.equal((await new Client(srv.base).adminLogin('editor.two', PW)).location, '/admin/products');
  });

  await t.test('role change / password reset / deactivation revoke the target\'s existing sessions', async () => {
    const owner = await login('owner_one');
    const id = (await pool.query("SELECT id FROM admin_accounts WHERE username='users_mgr'")).rows[0].id;
    const victim = await login('users_mgr');
    assert.equal((await victim.get('/admin/users')).status, 200);
    await owner.postWithCsrf(`/admin/admins/${id}/update`, { username: 'users_mgr', role: 'orders' }, '/admin/admins');
    assert.equal((await victim.get('/admin/users')).status, 403, 'old session revoked after role change');
    const v2 = await login('users_mgr');
    assert.equal((await v2.get('/admin/orders')).status, 200, 'new role effective');
    await owner.postWithCsrf(`/admin/admins/${id}/password`, { password: 'Another-Strong-Pass-1' }, '/admin/admins');
    assert.equal((await v2.get('/admin/orders')).status, 403, 'revoked after password reset');
    // The revoked browser can sign in again straight away: the login form it is shown carries a valid token.
    assert.equal((await v2.adminLogin('users_mgr', 'Another-Strong-Pass-1')).location, '/admin/orders', 'same browser re-login works without a "form expired" error');
    await v2.postWithCsrf('/admin/logout', {}, '/admin/orders');
    assert.equal((await new Client(srv.base).adminLogin('users_mgr', PW)).location, '/admin/login', 'old password no longer works');
    const v3 = new Client(srv.base);
    assert.equal((await v3.adminLogin('users_mgr', 'Another-Strong-Pass-1')).status, 302);
    await owner.postWithCsrf(`/admin/admins/${id}/toggle`, {}, '/admin/admins');
    assert.equal((await v3.get('/admin/orders')).status, 403, 'revoked after deactivation');
    assert.equal((await new Client(srv.base).adminLogin('users_mgr', 'Another-Strong-Pass-1')).location, '/admin/login');
    const actions = (await pool.query("SELECT action FROM admin_audit_logs WHERE action LIKE 'admin.account.%' ORDER BY id")).rows.map(r => r.action);
    assert.ok(actions.includes(`admin.account.update:${id}:orders`));
    assert.ok(actions.includes(`admin.account.password_reset:${id}`));
    assert.ok(actions.includes(`admin.account.deactivate:${id}`));
  });

  await t.test('the last active owner cannot be demoted or deactivated, and nobody can lock themselves out', async () => {
    const owner = await login('owner_one');
    await owner.postWithCsrf(`/admin/admins/${ownerId}/toggle`, {}, '/admin/admins');
    assert.match((await owner.flash('/admin/admins')).message, /حساب خود/);
    await owner.postWithCsrf(`/admin/admins/${ownerId}/update`, { username: 'owner_one', role: 'admin' }, '/admin/admins');
    assert.match((await owner.flash('/admin/admins')).message, /حساب خود/);
    // Race: two owners demote / deactivate each other at the same instant. The table lock must leave >= 1 active owner.
    for (const action of ['update', 'toggle']) {
      await pool.query("UPDATE admin_accounts SET role='owner', is_active=true WHERE username IN ('owner_one','owner_two')");
      if (!(await pool.query("SELECT 1 FROM admin_accounts WHERE username='owner_two'")).rowCount) await createAdmin(pool, 'owner_two', PW, 'owner');
      await pool.query("UPDATE admin_accounts SET role='content' WHERE role='owner' AND username NOT IN ('owner_one','owner_two')");
      const ids = Object.fromEntries((await pool.query("SELECT username,id FROM admin_accounts WHERE username IN ('owner_one','owner_two')")).rows.map(r => [r.username, r.id]));
      const a = await login('owner_one');
      const b = await login('owner_two');
      const [ta, tb] = [await a.csrf('/admin/admins'), await b.csrf('/admin/admins')];
      const body = target => action === 'update' ? { username: target, role: 'admin' } : {};
      await Promise.all([
        a.post(`/admin/admins/${ids.owner_two}/${action}`, { _csrf: ta, ...body('owner_two') }),
        b.post(`/admin/admins/${ids.owner_one}/${action}`, { _csrf: tb, ...body('owner_one') })
      ]);
      const owners = (await pool.query("SELECT COUNT(*)::int n FROM admin_accounts WHERE role='owner' AND is_active")).rows[0].n;
      assert.equal(owners, 1, `${action}: exactly one owner survives a concurrent mutual demotion`);
      const blocked = (await pool.query("SELECT COUNT(*)::int n FROM admin_audit_logs WHERE action LIKE 'admin.account.%'")).rows[0].n;
      assert.ok(blocked >= 1);
    }
    await pool.query("UPDATE admin_accounts SET role='owner', is_active=true WHERE username='owner_one'");
  });

  await t.test('self-service credential change requires the current password and ends the session', async () => {
    await createAdmin(pool, 'self_service', PW, 'content');
    const c = await login('self_service');
    await c.postWithCsrf('/admin/account/credentials', { current_password: 'wrong-password-xx', username: 'self_service', new_password: 'Brand-New-Password-1' }, '/admin/account');
    assert.match((await c.flash('/admin/account')).message, /رمز فعلی صحیح نیست/);
    await c.postWithCsrf('/admin/account/credentials', { current_password: PW, username: 'self_service', new_password: PW }, '/admin/account');
    assert.match((await c.flash('/admin/account')).message, /متفاوت/);
    const r = await c.postWithCsrf('/admin/account/credentials', { current_password: PW, username: 'self.renamed', new_password: 'Brand-New-Password-1' }, '/admin/account');
    assert.equal(r.location, '/admin/login');
    assert.equal((await c.get('/admin/account')).status, 403, 'session ended');
    assert.equal((await new Client(srv.base).adminLogin('self.renamed', 'Brand-New-Password-1')).location, '/admin/products');
  });

  await t.test('rejected mutations are audited as rejected, not as successes', async () => {
    const c = await login('admin_mgr');
    await c.postWithCsrf('/admin/products/1/edit', {}, '/admin/products/1/edit').catch(() => {});
    const fd = new FormData();
    fd.set('_csrf', await c.csrf('/admin/products/1/edit'));
    fd.set('title', ''); fd.set('price_toman', '1000');
    await c.request('POST', '/admin/products/1/edit', { multipart: fd });
    const row = (await pool.query("SELECT action,status_code FROM admin_audit_logs WHERE action LIKE 'admin.mutation%' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.match(row.action, /^admin\.mutation\.rejected:post/);
    assert.equal(row.status_code, 422);
  });
});
