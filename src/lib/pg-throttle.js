'use strict';
/**
 * Durable sliding-window failure counter on PostgreSQL.
 *
 * Adapted from Paradigmshift `apps/api/src/infra/pg-rate-limiter.ts` (PgRateLimiter) and
 * `rate-limit-retention.service.ts`, re-written for node-postgres instead of Prisma:
 *  - identifiers (username / IP / phone) are stored only as HMAC-SHA256 digests;
 *  - a transaction-scoped advisory lock per key serialises concurrent writers for the same key;
 *  - the database clock is authoritative, so the limit holds across restarts and multiple app replicas;
 *  - storage errors fail closed (callers must refuse the login attempt).
 *
 * Difference from the source: a successful login releases its reservation and clears the account key,
 * so only FAILED attempts accumulate and a legitimate administrator is not locked out by their own logins.
 */
const { createHmac } = require('node:crypto');

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

class ThrottleUnavailableError extends Error {
  constructor() { super('THROTTLE_UNAVAILABLE'); this.name = 'ThrottleUnavailableError'; }
}

class PgThrottle {
  constructor(pool, secret) {
    if (!pool) throw new Error('PgThrottle requires a pg pool');
    this.pool = pool;
    this.secret = secret || 'nogiti-local-development-throttle-key';
  }

  digest(key) {
    return createHmac('sha256', this.secret).update(`throttle:v1:${key}`).digest('hex');
  }

  static validate(limit, windowMs) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1 || windowMs > MAX_WINDOW_MS) {
      throw new RangeError('Throttle limit/window must be positive and within the retention bound.');
    }
  }

  /**
   * Atomic check-and-reserve, as in Paradigmshift's PgRateLimiter.hit(): under per-key advisory locks
   * (taken in a fixed order, so two requests can never deadlock) every key is counted; if any key is at
   * its limit nothing is recorded and the request is refused, otherwise one hit is recorded for each key.
   * This closes the race in a separate status() + recordFailure() sequence, where a burst of parallel
   * requests could all read "not blocked" before any failure was written.
   * The caller removes the reservation for keys that should only count failures (see release()).
   * @param {Array<{ key: string, limit: number, windowMs: number }>} rules
   * @returns {Promise<{ allowed: boolean, retryAfterMs: number, reservation: Array<{ digest: string, id: string }> }>}
   */
  async reserve(rules) {
    for (const r of rules) PgThrottle.validate(r.limit, r.windowMs);
    const items = rules.map(r => ({ ...r, digest: this.digest(r.key), windowMs: Math.floor(r.windowMs) }))
      .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
    let client;
    try { client = await this.pool.connect(); } catch { throw new ThrottleUnavailableError(); }
    try {
      await client.query('BEGIN');
      let retryAfterMs = 0;
      for (const item of items) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [item.digest]);
        await client.query(`DELETE FROM rate_limit_hits WHERE key_hash=$1 AND hit_at <= clock_timestamp() - ($2::double precision * interval '1 millisecond')`, [item.digest, item.windowMs]);
        const { rows } = await client.query(
          `SELECT count(*)::int AS count,
                  GREATEST(1, CEIL(EXTRACT(EPOCH FROM (min(hit_at) + ($2::double precision * interval '1 millisecond') - clock_timestamp())) * 1000))::int AS retry_ms
             FROM rate_limit_hits WHERE key_hash=$1`, [item.digest, item.windowMs]);
        if (Number(rows[0]?.count || 0) >= item.limit) retryAfterMs = Math.max(retryAfterMs, Number(rows[0]?.retry_ms) || 1);
      }
      if (retryAfterMs > 0) { await client.query('ROLLBACK'); return { allowed: false, retryAfterMs, reservation: [] }; }
      const reservation = [];
      for (const item of items) {
        const { rows } = await client.query('INSERT INTO rate_limit_hits(key_hash) VALUES($1) RETURNING id', [item.digest]);
        reservation.push({ key: item.key, digest: item.digest, id: rows[0].id });
      }
      await client.query('COMMIT');
      return { allowed: true, retryAfterMs: 0, reservation };
    } catch {
      await client.query('ROLLBACK').catch(() => {});
      throw new ThrottleUnavailableError();
    } finally {
      client.release();
    }
  }

  /** Removes the reserved hits for the given keys (e.g. a successful login does not count as a failure). */
  async release(reservation, keys) {
    const ids = reservation.filter(r => keys.includes(r.key)).map(r => r.id);
    if (!ids.length) return;
    try { await this.pool.query('DELETE FROM rate_limit_hits WHERE id = ANY($1::bigint[])', [ids]); } catch { /* best effort */ }
  }

  async clear(key) {
    try { await this.pool.query('DELETE FROM rate_limit_hits WHERE key_hash=$1', [this.digest(key)]); } catch { /* best effort */ }
  }

  /** Best-effort retention cleanup (batched). Never throws. */
  async purgeExpired(batch = 1000) {
    let total = 0;
    try {
      for (let i = 0; i < 20; i += 1) {
        const r = await this.pool.query(`DELETE FROM rate_limit_hits WHERE id IN (SELECT id FROM rate_limit_hits WHERE hit_at < clock_timestamp() - ($1::double precision * interval '1 millisecond') LIMIT $2)`, [MAX_WINDOW_MS, batch]);
        total += r.rowCount;
        if (r.rowCount < batch) break;
      }
    } catch { /* limiter prunes per key on every write */ }
    return total;
  }
}

module.exports = { PgThrottle, ThrottleUnavailableError, MAX_WINDOW_MS };
