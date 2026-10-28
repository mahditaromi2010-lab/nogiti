'use strict';
/**
 * Minimal JSON-based i18n layer for UI strings (nav, buttons, labels, admin panel, tickets, errors).
 * No translation library: a locale is a flat key->string JSON file, loaded once at start-up.
 * Real page content (product/article Persian text) is never machine-translated; that is handled
 * separately by the optional *_en columns, with the Persian text as fallback.
 */
const fs = require('node:fs');
const path = require('node:path');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const SUPPORTED = ['fa', 'en'];
const DEFAULT_LOCALE = 'fa';
const DIR_BY_LOCALE = { fa: 'rtl', en: 'ltr' };
const LOCALE_COOKIE = 'nugas.lang';

const dictionaries = Object.fromEntries(SUPPORTED.map(locale => [locale, JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8'))]));

function resolveLocale(value) {
  const v = String(value || '').toLowerCase().slice(0, 5);
  return SUPPORTED.includes(v) ? v : null;
}

/** Express middleware: picks the locale (query > cookie > default), exposes req.locale and a t() helper on res.locals. */
function i18nMiddleware() {
  return (req, res, next) => {
    const fromQuery = resolveLocale(req.query.lang);
    const fromCookie = resolveLocale(extractCookie(req.headers.cookie));
    const locale = fromQuery || fromCookie || DEFAULT_LOCALE;
    req.locale = locale;
    const dict = dictionaries[locale];
    const fallback = dictionaries[DEFAULT_LOCALE];
    const t = (key, fallbackText) => dict[key] ?? fallback[key] ?? fallbackText ?? key;
    res.locals.t = t;
    res.locals.locale = locale;
    res.locals.htmlDir = DIR_BY_LOCALE[locale] || 'rtl';
    res.locals.htmlLang = locale;
    // Picks the English column when present and the active locale is English, else the Persian value.
    res.locals.localizedField = (row, faKey, enKey) => (locale === 'en' && row && row[enKey]) ? row[enKey] : (row ? row[faKey] : '');
    next();
  };
}

function extractCookie(cookieHeader) {
  const match = String(cookieHeader || '').match(new RegExp(`${LOCALE_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

module.exports = { i18nMiddleware, resolveLocale, SUPPORTED, DEFAULT_LOCALE, LOCALE_COOKIE, DIR_BY_LOCALE };
