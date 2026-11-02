'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLocale, SUPPORTED, DEFAULT_LOCALE, i18nMiddleware } = require('../../src/lib/i18n');
const { permissionForPath, hasPermission } = require('../../src/admin-security');
const fa = require('../../src/locales/fa.json');
const en = require('../../src/locales/en.json');

test('resolveLocale only accepts supported locale codes', () => {
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('fa'), 'fa');
  assert.equal(resolveLocale('EN'), 'en');
  assert.equal(resolveLocale('de'), null);
  assert.equal(resolveLocale(''), null);
  assert.equal(resolveLocale(undefined), null);
  assert.deepEqual(SUPPORTED, ['fa', 'en']);
  assert.equal(DEFAULT_LOCALE, 'fa');
});

function runMiddleware(req) {
  const res = { locals: {} };
  let nextCalled = false;
  i18nMiddleware()(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled);
  return res;
}

test('i18n middleware defaults to fa/rtl and falls back to the fa string for a missing en key', () => {
  const res = runMiddleware({ query: {}, headers: {} });
  assert.equal(res.locals.locale, 'fa');
  assert.equal(res.locals.htmlDir, 'rtl');
  assert.equal(res.locals.t('nav.shop'), 'فروشگاه');
});

test('i18n middleware honours a ?lang= query override and switches direction to ltr', () => {
  const res = runMiddleware({ query: { lang: 'en' }, headers: {} });
  assert.equal(res.locals.locale, 'en');
  assert.equal(res.locals.htmlDir, 'ltr');
  assert.equal(res.locals.t('nav.shop'), 'Shop');
});

test('i18n middleware reads the locale cookie when no query override is present', () => {
  const res = runMiddleware({ query: {}, headers: { cookie: 'nugas.lang=en; other=1' } });
  assert.equal(res.locals.locale, 'en');
});

test('localizedField falls back to the Persian column when the English one is empty', () => {
  const res = runMiddleware({ query: { lang: 'en' }, headers: {} });
  assert.equal(res.locals.localizedField({ title: 'فا', title_en: '' }, 'title', 'title_en'), 'فا');
  assert.equal(res.locals.localizedField({ title: 'فا', title_en: 'EN' }, 'title', 'title_en'), 'EN');
  const fa = runMiddleware({ query: {}, headers: {} });
  assert.equal(fa.locals.localizedField({ title: 'فا', title_en: 'EN' }, 'title', 'title_en'), 'فا');
});

test('fa.json and en.json carry exactly the same set of keys (no locale can silently fall behind)', () => {
  const faKeys = Object.keys(fa).sort();
  const enKeys = Object.keys(en).sort();
  const missingFromEn = faKeys.filter(k => !en[k] && en[k] !== '');
  const missingFromFa = enKeys.filter(k => !fa[k] && fa[k] !== '');
  assert.deepEqual(missingFromEn, [], `en.json is missing keys present in fa.json: ${missingFromEn.join(', ')}`);
  assert.deepEqual(missingFromFa, [], `fa.json is missing keys present in en.json: ${missingFromFa.join(', ')}`);
  assert.equal(faKeys.length, enKeys.length);
});

test('every locale value is a non-empty string (no accidental null/undefined/empty entries)', () => {
  for (const [key, value] of Object.entries(fa)) assert.equal(typeof value, 'string', `fa.json[${key}] should be a string`);
  for (const [key, value] of Object.entries(en)) assert.equal(typeof value, 'string', `en.json[${key}] should be a string`);
});

test('the support permission exists and is granted only to the broad admin roles', () => {
  assert.equal(permissionForPath('/admin/tickets'), 'support');
  assert.equal(permissionForPath('/admin/tickets/5/reply'), 'support');
  assert.equal(permissionForPath('/admin/team'), 'content');
  assert.ok(hasPermission('owner', 'support'));
  assert.ok(hasPermission('admin', 'support'));
  assert.ok(!hasPermission('content', 'support'));
  assert.ok(!hasPermission('orders', 'support'));
  assert.ok(!hasPermission('users', 'support'));
});
