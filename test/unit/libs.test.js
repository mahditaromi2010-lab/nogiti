'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectFileType, validateStoredFile } = require('../../src/lib/upload-validation');
const { redactValue, maskPhone } = require('../../src/lib/redaction');
const { normalizeIranMobile, normalizePersianSearch, likeContains, digitsEnglish, isValidEmail, sqlSearchFold } = require('../../src/lib/text');
const { renderArticleBody, isSafeHref } = require('../../src/lib/rich-text');
const { safeNextPath } = require('../../src/lib/safe-next');
const { buildWhere, pagination, parsePage, queryString } = require('../../src/lib/listing');
const { permissionForPath, adminPasswordProblem, ROLE_HOME, ROLES } = require('../../src/admin-security');
const { listMigrations } = require('../../src/lib/migrations');

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const pdf = Buffer.from('%PDF-1.7\n');
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4)]);
const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(4)]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]);

test('magic-byte detection recognises only the formats Nogiti accepts', () => {
  assert.equal(detectFileType(png).mime, 'image/png');
  assert.equal(detectFileType(jpg).ext, '.jpg');
  assert.equal(detectFileType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')).mime, 'image/webp');
  assert.equal(detectFileType(Buffer.from('GIF89a......')).kind, 'image');
  assert.equal(detectFileType(pdf).kind, 'pdf');
  assert.equal(detectFileType(zip).kind, 'zip');
  assert.equal(detectFileType(mp4).ext, '.mp4');
  assert.equal(detectFileType(webm).ext, '.webm');
  assert.equal(detectFileType(mov), null, 'QuickTime is not served by Nogiti');
  assert.equal(detectFileType(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(detectFileType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(detectFileType(Buffer.from('MZ\x90\x00')), null, 'executables rejected');
  assert.equal(detectFileType(Buffer.alloc(0)), null);
});

test('stored-file validation enforces kind and extension consistency', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nogiti-upl-'));
  const write = (name, bytes) => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p; };
  assert.equal((await validateStoredFile(write('a.png', png), { allowedKinds: ['image'], expectedExt: '.png' })).ok, true);
  assert.equal((await validateStoredFile(write('b.png', Buffer.from('<html>')), { allowedKinds: ['image'], expectedExt: '.png' })).reason, 'UNSUPPORTED_FILE');
  assert.equal((await validateStoredFile(write('c.png', jpg), { allowedKinds: ['image'], expectedExt: '.png' })).reason, 'EXTENSION_MISMATCH');
  assert.equal((await validateStoredFile(write('d.jpeg', jpg), { allowedKinds: ['image'], expectedExt: '.jpeg' })).ok, true);
  assert.equal((await validateStoredFile(write('e.mp4', pdf), { allowedKinds: ['video'], expectedExt: '.mp4' })).reason, 'KIND_MISMATCH');
  assert.equal((await validateStoredFile(write('f.zip', Buffer.alloc(0)), { allowedKinds: ['zip'] })).reason, 'EMPTY_FILE');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('log redaction hides credentials, OTP and phone numbers', () => {
  const out = redactValue({ password: 'x', _csrf: 'y', phone: '09121234567', nested: { apiKey: 'k', note: 'call 09121234567 now' }, url: 'https://api.kavenegar.com/v1/SECRETKEY/sms/send.json' });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out._csrf, '[REDACTED]');
  assert.equal(out.nested.apiKey, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(out), /09121234567|SECRETKEY/);
  assert.equal(maskPhone('09121234567'), '0912*****67');
  const err = redactValue(new Error('failed for 09121234567'));
  assert.doesNotMatch(err.message, /09121234567/);
});

test('Iranian mobile normalisation keeps the 09XXXXXXXXX storage format', () => {
  for (const input of ['09121234567', '۰۹۱۲۱۲۳۴۵۶۷', '+989121234567', '00989121234567', '989121234567', '9121234567', '0912 123 4567', '(0912)-123-4567']) {
    assert.equal(normalizeIranMobile(input), '09121234567', input);
  }
  for (const bad of ['0812123456', '091212345', 'abc', '', '+1 202 555 0100', '0'.repeat(40)]) assert.equal(normalizeIranMobile(bad), null, bad);
  assert.equal(digitsEnglish('۱۲۳٤٥'), '12345');
});

test('Persian search normalisation and LIKE escaping', () => {
  assert.equal(normalizePersianSearch('  كتاب  عربي '), 'کتاب عربی');
  assert.equal(normalizePersianSearch('مهندسـی'), 'مهندسی', 'tatweel removed');
  assert.equal(likeContains('50%_off\\'), '%50\\%\\_off\\\\%');
  assert.throws(() => sqlSearchFold('title; DROP TABLE x'));
  const w = buildWhere({ q: 'كد', searchColumns: ['p.title'], filters: [['p.status', 'draft'], ['p.type', '']] });
  assert.match(w.where, /translate\(p\.title, 'يىك/);
  assert.match(w.where, /ILIKE \$1/);
  assert.match(w.where, /p\.status=\$2/);
  assert.deepEqual(w.params, ['%کد%', 'draft']);
  assert.throws(() => buildWhere({ filters: [['x;--', 1]] }));
});

test('pagination helpers clamp input', () => {
  assert.equal(parsePage('-3'), 1);
  assert.equal(parsePage('abc'), 1);
  assert.equal(parsePage('5'), 5);
  assert.deepEqual(pagination(9, 25, 30), { page: 2, pageSize: 25, total: 30, pages: 2, offset: 25 });
  assert.equal(queryString({ q: 'a b', status: '', page: 1 }), '?q=a+b');
  assert.equal(queryString({ page: 3 }), '?page=3');
});

test('article renderer escapes HTML and only emits safe links', () => {
  const html = renderArticleBody('<script>alert(1)</script>\n## عنوان\n- یک\n- دو\n> نکته\n**مهم** [ok](https://x.ir) [bad](javascript:alert(1)) [rel](/tools)\n[[image:5]]\n[[image:99]]', [{ id: 5, image_path: '/media/covers/a.png', alt_text: '"><img onerror=1>' }]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<h2>عنوان<\/h2>/);
  assert.match(html, /<ul><li>یک<\/li><li>دو<\/li><\/ul>/);
  assert.match(html, /<blockquote>نکته<\/blockquote>/);
  assert.match(html, /<strong>مهم<\/strong>/);
  assert.match(html, /<a href="https:\/\/x\.ir" target="_blank" rel="noopener noreferrer nofollow">ok<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<a href="\/tools">rel<\/a>/);
  assert.match(html, /<figure class="inline-article-image"><img src="\/media\/covers\/a\.png" alt="&quot;&gt;&lt;img onerror=1&gt;"/);
  assert.equal((html.match(/<figure/g) || []).length, 1, 'unknown image ids are dropped');
  // Existing content contract: each plain line is its own paragraph.
  assert.equal(renderArticleBody('خط اول\nخط دوم'), '<p>خط اول</p><p>خط دوم</p>');
  assert.equal(isSafeHref('//evil.com'), false);
  assert.equal(isSafeHref('http://insecure.ir'), false);
});

test('post-login redirects only allow same-site customer paths', () => {
  assert.equal(safeNextPath('/shop/autocad-plugin'), '/shop/autocad-plugin');
  assert.equal(safeNextPath('/account?tab=orders'), '/account?tab=orders');
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', '/admin', '/login', 'javascript:alert(1)', '/shop\u0000', '']) {
    assert.equal(safeNextPath(bad), '/account', bad);
  }
});

test('role matrix: assets are content operations, every role has a reachable home', () => {
  assert.equal(permissionForPath('/admin/assets/3/delete'), 'content');
  for (const role of ROLES) assert.ok(ROLE_HOME[role]);
  assert.equal(adminPasswordProblem('short'), 'رمز عبور باید بین ۱۲ تا ۲۰۰ نویسه باشد.');
  assert.match(adminPasswordProblem('my-site_owner-2026', 'site_owner'), /نام کاربری/);
  assert.match(adminPasswordProblem('aaaaaaaaaaaaaa'), /تکرار/);
  assert.equal(adminPasswordProblem('Correct-Horse-Battery-9', 'site_owner'), null);
  // bcrypt ignores bytes after the 72nd: such passwords are refused instead of silently truncated.
  assert.equal(adminPasswordProblem('Ab3-'.repeat(18)), null, '72 ASCII bytes are accepted');
  assert.match(adminPasswordProblem('Ab3-'.repeat(18) + 'x'), /۷۲ بایت/);
  assert.match(adminPasswordProblem('رمزعبورطولانی'.repeat(3)), /۷۲ بایت/, '39 Persian letters = 78 bytes');
});

test('Persian search keeps digits and folds them; ISO-BMFF stills are not videos', () => {
  const { normalizePersianSearch, sqlSearchFold } = require('../../src/lib/text');
  assert.equal(normalizePersianSearch('دوره ٣٤ و ۱۴۰۳'), 'دوره 34 و 1403', 'Arabic-Indic and Persian digits become ASCII, not deleted');
  assert.match(sqlSearchFold('p.title'), /^translate\(p\.title, '/);
  assert.throws(() => sqlSearchFold('title; DROP TABLE x'), /Invalid column/);
  const { detectFileType } = require('../../src/lib/upload-validation');
  const box = brand => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(16)]);
  assert.equal(detectFileType(box('isom')).kind, 'video');
  assert.equal(detectFileType(box('mp42')).kind, 'video');
  for (const brand of ['heic', 'avif', 'mif1', 'qt  ', 'M4A ']) assert.equal(detectFileType(box(brand)), null, brand);
});

test('migrations are ordered, named consistently and have reviewed rollbacks where reversible', () => {
  const list = listMigrations();
  assert.deepEqual(list.map(m => m.version), ['0001', '0002', '0003', '0004', '0005']);
  assert.equal(list[0].downPath, null, 'baseline is restore-from-backup only');
  for (const m of list.slice(1)) assert.ok(m.downPath, `${m.name} should have a reviewed .down.sql`);
  // "ON DELETE CASCADE"/"ON DELETE SET NULL" are normal FK clauses, not destructive statements.
  for (const m of list.slice(1)) assert.doesNotMatch(m.sql, /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i, `${m.name}: forward migration is additive`);
  assert.ok(isValidEmail('a@b.ir'));
  assert.ok(!isValidEmail('a@b'));
});

test('environment validation fails closed in production and never echoes values', () => {
  const { checkEnvironment } = require('../../src/lib/config');
  const secret = 'Zx9-unique-production-secret-value-2026-abcdef';
  const ok = checkEnvironment({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db/nugas', APP_URL: 'https://nogiti.ir', APP_SECRET: secret, TRUST_PROXY: 'true', KAVENEGAR_API_KEY: 'k', ZARINPAL_MERCHANT_ID: 'm', ZARINPAL_SANDBOX: 'false' });
  assert.deepEqual(ok, { errors: [], warnings: [] });
  const bad = checkEnvironment({ NODE_ENV: 'production', DATABASE_URL: 'mysql://x', APP_SECRET: 'replace-with-a-random-secret-at-least-32-characters-long', TRUST_PROXY: 'yes', MAX_UPLOAD_MB: 'lots' });
  assert.ok(bad.errors.some(e => e.startsWith('APP_SECRET')));
  assert.ok(bad.errors.some(e => e.startsWith('DATABASE_URL')));
  assert.ok(bad.errors.some(e => e.startsWith('TRUST_PROXY')));
  assert.ok(bad.errors.some(e => e.startsWith('MAX_UPLOAD_MB')));
  assert.ok(bad.errors.some(e => e.startsWith('APP_URL is required')));
  assert.doesNotMatch(JSON.stringify(bad), /mysql:\/\/x|replace-with|lots/, 'values are never echoed');
  const http = checkEnvironment({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db/n', APP_URL: 'http://localhost:3000', APP_SECRET: secret });
  assert.deepEqual(http.errors, []);
  assert.ok(http.warnings.some(w => /not marked Secure/.test(w)));
  assert.ok(http.warnings.some(w => /OTP login is disabled/.test(w)));
  assert.deepEqual(checkEnvironment({ DATABASE_URL: 'postgres://localhost/nugas' }).errors, [], 'development needs only DATABASE_URL');
});
