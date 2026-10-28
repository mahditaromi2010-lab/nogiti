'use strict';
/**
 * Server-side search / filter / pagination helper for admin tables (EJS).
 * Pattern inspired by Paradigmshift `apps/web/lib/catalog-query.ts`; rebuilt for parameterised SQL.
 */
const { normalizePersianSearch, sqlSearchFold, likeContains } = require('./text');

function parsePage(value, max = 100000) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, max) : 1;
}

/**
 * Builds a WHERE clause from optional search and equality filters.
 * @param {{ q?: string, searchColumns?: string[], filters?: Array<[string, any]>, base?: string[] }} spec
 */
function buildWhere({ q = '', searchColumns = [], filters = [], base = [] }) {
  const clauses = [...base];
  const params = [];
  const query = normalizePersianSearch(q).slice(0, 100);
  if (query && searchColumns.length) {
    params.push(likeContains(query));
    clauses.push(`(${searchColumns.map(c => `${sqlSearchFold(c)} ILIKE $${params.length}`).join(' OR ')})`);
  }
  for (const [column, value] of filters) {
    if (value === undefined || value === null || value === '') continue;
    if (!/^[a-z_][a-z0-9_.]*$/i.test(column)) throw new Error('Invalid column identifier');
    params.push(value);
    clauses.push(`${column}=$${params.length}`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, q: query };
}

function pagination(page, pageSize, total) {
  const pages = Math.max(1, Math.ceil(Number(total || 0) / pageSize));
  const current = Math.min(page, pages);
  return { page: current, pageSize, total: Number(total || 0), pages, offset: (current - 1) * pageSize };
}

/** Builds a query string preserving current filters (used by pagination links). */
function queryString(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && !(k === 'page' && Number(v) === 1)) usp.set(k, String(v));
  const s = usp.toString();
  return s ? `?${s}` : '';
}

module.exports = { parsePage, buildWhere, pagination, queryString };
