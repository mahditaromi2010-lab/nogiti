'use strict';
/**
 * Persian text helpers.
 * - normalizePersianSearch: from Paradigmshift `apps/api/src/catalog/persian-search.ts`.
 * - normalizeIranMobile: adapted from Paradigmshift `apps/api/src/common/phone.ts`, but returns Nogiti's
 *   existing storage format (09XXXXXXXXX) instead of E.164 so existing `users.phone` rows keep matching.
 */
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function digitsEnglish(value) {
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, ch => {
    const p = PERSIAN_DIGITS.indexOf(ch);
    return String(p >= 0 ? p : ARABIC_DIGITS.indexOf(ch));
  });
}

/**
 * Normalize Arabic/Persian letter variants for search only; never used to mutate stored text.
 * Folds ي/ى→ی and ك→ک, removes harakat (U+064B–U+065F), superscript alef (U+0670) and tatweel (U+0640),
 * turns ZWNJ/RLM/LRM into spaces and Persian/Arabic-Indic digits into ASCII digits.
 * Unlike the Paradigmshift original, which folds only the query, the same folding is applied to the
 * stored column in SQL (sqlSearchFold), so "كولر" in the database is found by "کولر" and vice versa.
 */
function normalizePersianSearch(value) {
  return digitsEnglish(String(value ?? '').normalize('NFKC'))
    .replace(/[\u064A\u0649]/gu, '\u06CC')
    .replace(/\u0643/gu, '\u06A9')
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, '')
    .replace(/[\u200C\u200E\u200F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

// translate() source/target pairs: letters and digits are mapped, the remaining source characters are deleted.
const FOLD_FROM = '\u064A\u0649\u0643\u200C\u200E\u200F' + PERSIAN_DIGITS + ARABIC_DIGITS;
const FOLD_TO = '\u06CC\u06CC\u06A9   ' + '0123456789'.repeat(2);
const FOLD_DELETE = [...Array.from({ length: 0x065f - 0x064b + 1 }, (_, i) => String.fromCharCode(0x064b + i)), '\u0670', '\u0640'].join('');
/** SQL expression applying the same folding as normalizePersianSearch to a column (for ILIKE comparisons). */
function sqlSearchFold(column) {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(column)) throw new Error('Invalid column identifier');
  return `translate(${column}, '${FOLD_FROM}${FOLD_DELETE}', '${FOLD_TO}')`;
}

/** Escape LIKE wildcards so user input is matched literally. */
function likeContains(value) {
  return `%${String(value).replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
}

/**
 * Accepts 09121234567, 9121234567, +989121234567, 00989121234567, 989121234567,
 * with Persian/Arabic digits, spaces, dashes and parentheses. Returns 09XXXXXXXXX or null.
 */
function normalizeIranMobile(raw) {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  let s = digitsEnglish(raw).replace(/[\s\-().‌‏‎]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('98') && s.length === 12) s = s.slice(2);
  else if (s.startsWith('0')) s = s.slice(1);
  if (!/^9\d{9}$/.test(s)) return null;
  return `0${s}`;
}

function normalizeText(value, max = 10000) { return String(value ?? '').trim().slice(0, max); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 180 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(value);
}

module.exports = { digitsEnglish, normalizePersianSearch, sqlSearchFold, likeContains, normalizeIranMobile, normalizeText, escapeHtml, isValidEmail };
