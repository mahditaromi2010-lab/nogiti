'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const server = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'db/migrations/0001_baseline.sql'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'scripts/create-admin.js'), 'utf8');

test('administrative identity is separated from OTP customer accounts', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS admin_accounts/);
  assert.match(schema, /username VARCHAR\(64\) NOT NULL UNIQUE/);
  assert.match(schema, /password_hash TEXT NOT NULL/);
  assert.match(schema, /session_version INTEGER NOT NULL DEFAULT 1/);
  assert.match(server, /FROM admin_accounts WHERE username=\$1/);
  assert.doesNotMatch(server.slice(server.indexOf("app.post('/admin/login'"), server.indexOf("app.post('/admin/logout'")), /FROM users u JOIN admin_credentials/);
});

test('all registered non-login admin routes require server-side authorization', () => {
  const routeLines = server.split('\n').filter(line => /app\.(?:get|post|put|patch|delete)\('\/admin/.test(line));
  const unprotected = routeLines.filter(line => !/requireAdmin/.test(line) && !/app\.(?:get|post)\('\/admin\/login'/.test(line));
  assert.deepEqual(unprotected, []);
});

test('owner bootstrap requires explicit environment credentials and hashes passwords', () => {
  assert.match(bootstrap, /ADMIN_USERNAME/);
  assert.match(bootstrap, /ADMIN_PASSWORD/);
  assert.match(bootstrap, /bcrypt\.hash\(ADMIN_PASSWORD, 12\)/);
  assert.match(bootstrap, /adminPasswordProblem/);
  assert.doesNotMatch(bootstrap, /ADMIN_PHONE/);
});


test('legacy admin migration does not grant owner to every imported account', () => {
  assert.match(schema, /ROW_NUMBER\(\) OVER \(ORDER BY u\.is_active DESC, u\.id ASC\)/);
  assert.match(schema, /CASE WHEN position=1 THEN 'owner' ELSE 'admin' END/);
  assert.doesNotMatch(schema, /SELECT 'legacy_admin_' \|\| u\.id::text, c\.password_hash, 'owner', u\.is_active/);
});
