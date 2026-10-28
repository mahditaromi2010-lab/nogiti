'use strict';
/**
 * Versioned SQL migrations for Nogiti (no ORM).
 *  - db/migrations/NNNN_name.sql            forward migration (runs in one transaction)
 *  - db/migrations/NNNN_name.down.sql       optional reviewed rollback
 * Applied versions are recorded with a SHA-256 checksum in schema_migrations. A cluster-wide advisory
 * lock prevents two app instances from migrating at the same time (e.g. two containers starting).
 * Idea and rollback-note convention adapted from Paradigmshift's Prisma migrations; implemented for pg.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db', 'migrations');
const LOCK_KEY = 74_212_026; // arbitrary constant for pg_advisory_lock

function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map(file => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      const version = file.slice(0, 4);
      const downFile = file.replace(/\.sql$/, '.down.sql');
      return {
        version, name: file.replace(/\.sql$/, ''), file, sql,
        checksum: crypto.createHash('sha256').update(sql).digest('hex'),
        downPath: fs.existsSync(path.join(dir, downFile)) ? path.join(dir, downFile) : null
      };
    });
}

async function ensureTable(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(4) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function withLock(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try { return await fn(client); } finally { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {}); }
  } finally { client.release(); }
}

async function status(pool, dir) {
  return withLock(pool, async client => {
    await ensureTable(client);
    const applied = new Map((await client.query('SELECT version,name,checksum,applied_at FROM schema_migrations')).rows.map(r => [r.version, r]));
    return listMigrations(dir).map(m => ({
      version: m.version, name: m.name,
      applied: applied.has(m.version),
      appliedAt: applied.get(m.version)?.applied_at || null,
      checksumMismatch: applied.has(m.version) && applied.get(m.version).checksum !== m.checksum
    }));
  });
}

async function migrateUp(pool, { dir, log = () => {} } = {}) {
  return withLock(pool, async client => {
    await ensureTable(client);
    const applied = new Map((await client.query('SELECT version,checksum FROM schema_migrations')).rows.map(r => [r.version, r.checksum]));
    const ran = [];
    for (const m of listMigrations(dir)) {
      if (applied.has(m.version)) {
        if (applied.get(m.version) !== m.checksum) {
          throw new Error(`Migration ${m.name} was modified after being applied (checksum mismatch). Create a new migration instead of editing an applied one.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [m.version, m.name, m.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        error.message = `Migration ${m.name} failed and was rolled back: ${error.message}`;
        throw error;
      }
      ran.push(m.name);
      log(`applied ${m.name}`);
    }
    return ran;
  });
}

async function migrateDown(pool, version, { dir } = {}) {
  const target = listMigrations(dir).find(m => m.version === version);
  if (!target) throw new Error(`Unknown migration version ${version}`);
  if (!target.downPath) throw new Error(`Migration ${target.name} has no reviewed .down.sql; restore from backup instead.`);
  return withLock(pool, async client => {
    await ensureTable(client);
    const latest = await client.query('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    if (latest.rows[0]?.version !== version) throw new Error(`Only the most recently applied migration can be rolled back (latest is ${latest.rows[0]?.version || 'none'}).`);
    await client.query('BEGIN');
    try {
      await client.query(fs.readFileSync(target.downPath, 'utf8'));
      await client.query('DELETE FROM schema_migrations WHERE version=$1', [version]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    return target.name;
  });
}

module.exports = { listMigrations, migrateUp, migrateDown, status, MIGRATIONS_DIR };
