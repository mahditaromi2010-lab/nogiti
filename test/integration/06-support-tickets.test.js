'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, newPool, resetDatabase, startApp, Client, createAdmin } = require('./helpers');
const { migrateUp } = require('../../src/lib/migrations');

const PW = 'Strong-Password-2026!';

async function loginCustomer(base, phone = '09121234567') {
  const c = new Client(base);
  const token1 = await c.csrf('/login');
  await c.post('/auth/request-code', { _csrf: token1, phone, firstName: 'کاربر', lastName: 'تست' });
  const page = await c.get('/login?step=code');
  const m = page.text.match(/<strong>(\d{6})<\/strong>/);
  assert.ok(m, 'dev OTP code shown on the login page');
  const token2 = await c.csrf('/login?step=code');
  const r = await c.post('/auth/verify-code', { _csrf: token2, code: m[1] });
  assert.equal(r.status, 302, 'verify-code should redirect after login');
  return c;
}

test('support ticket flow: user creates a ticket, it appears in the admin list, admin replies, user sees the reply', { skip: skipReason, concurrency: false }, async t => {
  const pool = newPool();
  await resetDatabase(pool);
  await migrateUp(pool);
  await createAdmin(pool, 'owner_support', PW, 'owner');
  const srv = await startApp({ pool });
  t.after(async () => { await srv.stop(); await pool.end(); });

  const user = await loginCustomer(srv.base);

  await t.test('a customer without access cannot see other users tickets, and ticket creation requires fields', async () => {
    const token = await user.csrf('/account/tickets/new');
    const empty = await user.post('/account/tickets', { _csrf: token, subject: '', category: 'other', priority: 'normal', message: '' });
    assert.equal(empty.status, 302);
    assert.equal((await pool.query('SELECT COUNT(*)::int n FROM tickets')).rows[0].n, 0, 'empty submission created no ticket');
  });

  let ticketId;
  await t.test('customer opens a support ticket', async () => {
    const token = await user.csrf('/account/tickets/new');
    const r = await user.post('/account/tickets', { _csrf: token, subject: 'مشکل در دانلود فایل دوره', category: 'product', priority: 'high', message: 'لینک دانلود فایل دوره کار نمی‌کند.' });
    assert.equal(r.status, 302);
    const row = (await pool.query('SELECT id,status,user_id FROM tickets ORDER BY id DESC LIMIT 1')).rows[0];
    ticketId = row.id;
    assert.equal(row.status, 'open');
    const msgs = (await pool.query('SELECT author_type,body FROM ticket_messages WHERE ticket_id=$1', [ticketId])).rows;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].author_type, 'user');
  });

  await t.test('the ticket appears in the admin list and detail view', async () => {
    const admin = new Client(srv.base);
    assert.equal((await admin.adminLogin('owner_support', PW)).status, 302);
    const list = await admin.get('/admin/tickets');
    assert.equal(list.status, 200);
    assert.match(list.text, /مشکل در دانلود فایل دوره/);
    const detail = await admin.get(`/admin/tickets/${ticketId}`);
    assert.equal(detail.status, 200);
    assert.match(detail.text, /لینک دانلود فایل دوره کار نمی‌کند/);
  });

  await t.test('admin replies; the ticket becomes "answered" and the customer sees the reply', async () => {
    const admin = new Client(srv.base);
    await admin.adminLogin('owner_support', PW);
    const token = await admin.csrf(`/admin/tickets/${ticketId}`);
    const r = await admin.post(`/admin/tickets/${ticketId}/reply`, { _csrf: token, message: 'سلام؛ لینک جدید را به‌زودی ارسال می‌کنیم.' });
    assert.equal(r.status, 302);
    assert.equal((await pool.query('SELECT status FROM tickets WHERE id=$1', [ticketId])).rows[0].status, 'answered');
    const view = await user.get(`/account/tickets/${ticketId}`);
    assert.equal(view.status, 200);
    assert.match(view.text, /لینک جدید را به‌زودی ارسال می‌کنیم/);
  });

  await t.test('customer replies back; the ticket moves to "pending" for the admin', async () => {
    const token = await user.csrf(`/account/tickets/${ticketId}`);
    const r = await user.post(`/account/tickets/${ticketId}/reply`, { _csrf: token, message: 'متشکرم، منتظر لینک هستم.' });
    assert.equal(r.status, 302);
    assert.equal((await pool.query('SELECT status FROM tickets WHERE id=$1', [ticketId])).rows[0].status, 'pending');
  });

  await t.test('a customer cannot open another customer\'s ticket by id', async () => {
    const other = await loginCustomer(srv.base, '09129876543');
    const r = await other.get(`/account/tickets/${ticketId}`);
    assert.equal(r.status, 404);
  });

  await t.test('a role without the support permission is blocked from every ticket route, server-side', async () => {
    await createAdmin(pool, 'content_only', PW, 'content');
    const content = new Client(srv.base);
    assert.equal((await content.adminLogin('content_only', PW)).status, 302);
    assert.equal((await content.get('/admin/tickets')).status, 403, 'list blocked');
    assert.equal((await content.get(`/admin/tickets/${ticketId}`)).status, 403, 'detail blocked');
    const token = await content.csrf('/admin/products');
    assert.equal((await content.post(`/admin/tickets/${ticketId}/reply`, { _csrf: token, message: 'x' })).status, 403, 'reply blocked');
    assert.equal((await content.post(`/admin/tickets/${ticketId}/status`, { _csrf: token, status: 'closed', priority: 'low' })).status, 403, 'status change blocked');
    // the nav must not even surface the section to a role that cannot use it
    assert.doesNotMatch((await content.get('/admin/products')).text, /href="\/admin\/tickets"/);
  });
});
