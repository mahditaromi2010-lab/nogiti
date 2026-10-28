'use strict';
/**
 * Integration-test harness: real PostgreSQL, real Express app on an ephemeral port, cookie-aware client.
 * Requires TEST_DATABASE_URL pointing at a DISPOSABLE database whose name contains "test"
 * (the public schema is dropped and recreated). Without it the integration tests are skipped.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const TEST_DB = process.env.TEST_DATABASE_URL || '';
const skipReason = !TEST_DB ? 'TEST_DATABASE_URL is not set (integration tests need a disposable PostgreSQL database)' : (!/test/i.test(new URL(TEST_DB).pathname) ? 'TEST_DATABASE_URL database name must contain "test"' : false);

function configureEnv(extra = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'test', APP_SECRET: 'integration-test-secret-0123456789abcdef', SHOW_DEV_OTP: 'true',
    APP_URL: 'http://127.0.0.1', KAVENEGAR_API_KEY: '', ZARINPAL_MERCHANT_ID: '', TRUST_PROXY: 'false', LOG_LEVEL: 'silent'
  }, extra);
}

async function resetDatabase(pool) {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function startApp({ pool, uploadDir } = {}) {
  configureEnv();
  delete require.cache[require.resolve('../../src/app')];
  const { createApp } = require('../../src/app');
  const { createLogger } = require('../../src/lib/logger');
  const dir = uploadDir || fs.mkdtempSync(path.join(os.tmpdir(), 'nogiti-it-'));
  const { app, close } = createApp({ pool, logger: createLogger('test', process.env.TEST_LOG_LEVEL || 'silent'), uploadDir: dir });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, uploadDir: dir, stop: () => new Promise(r => { close(); server.close(r); }) };
}

class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (attrs.some(a => /max-age=0|expires=thu, 01 jan 1970/i.test(a)) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  async request(method, url, { form, multipart, headers = {}, follow = false } = {}) {
    let body;
    const h = { ...headers };
    if (this.cookies.size) h.cookie = this.cookieHeader();
    if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    if (multipart) body = multipart;
    let res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    this.store(res);
    let text = await res.text();
    let hops = 0;
    while (follow && res.status >= 300 && res.status < 400 && hops++ < 5) {
      const loc = new URL(res.headers.get('location'), this.base);
      res = await fetch(loc.origin === this.base ? loc.href : loc.href, { headers: this.cookies.size ? { cookie: this.cookieHeader() } : {}, redirect: 'manual' });
      this.store(res);
      text = await res.text();
    }
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location') };
  }
  get(url, opts) { return this.request('GET', url, opts); }
  post(url, form, opts = {}) { return this.request('POST', url, { ...opts, form }); }
  async csrf(url = '/') {
    const r = await this.get(url);
    const m = r.text.match(/name="_csrf" value="([^"]+)"/);
    if (!m) throw new Error(`no csrf token on ${url} (status ${r.status})`);
    return m[1];
  }
  async postWithCsrf(url, form = {}, from = url) {
    const token = await this.csrf(from);
    return this.post(url, { _csrf: token, ...form });
  }
  async adminLogin(username, password) {
    const token = await this.csrf('/admin/login');
    return this.post('/admin/login', { _csrf: token, username, password });
  }
  async flash(url) { const r = await this.get(url); const m = r.text.match(/class="flash flash-(\w+)"[^>]*>([^<]*)/); return m ? { type: m[1], message: m[2] } : null; }
}

async function createAdmin(pool, username, password, role = 'owner', active = true) {
  const hash = await bcrypt.hash(password, 4); // low cost keeps the suite fast; production uses 12
  const r = await pool.query('INSERT INTO admin_accounts(username,password_hash,role,is_active) VALUES($1,$2,$3,$4) RETURNING id', [username, hash, role, active]);
  return r.rows[0].id;
}

function newPool() { return new Pool({ connectionString: TEST_DB, max: 8 }); }

module.exports = { skipReason, TEST_DB, newPool, resetDatabase, startApp, Client, createAdmin, configureEnv };
