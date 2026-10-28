require('dotenv').config();
const { Pool } = require('pg');
const { migrateUp, migrateDown, status } = require('../src/lib/migrations');

// Usage:
//   npm run db:migrate                         apply pending migrations
//   npm run db:status                          list applied / pending migrations
//   CONFIRM_ROLLBACK=YES node scripts/migrate.js --down 0002   revert the latest migration (take a backup first)
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL در فایل .env تنظیم نشده است.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined });
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--status') {
      for (const m of await status(pool)) console.log(`${m.applied ? 'applied ' : 'PENDING '} ${m.name}${m.checksumMismatch ? '  (CHECKSUM MISMATCH)' : ''}`);
      return;
    }
    if (args[0] === '--down') {
      if (process.env.CONFIRM_ROLLBACK !== 'YES') throw new Error('Refusing rollback: take a database backup, then set CONFIRM_ROLLBACK=YES.');
      const name = await migrateDown(pool, String(args[1] || ''));
      console.log(`Rolled back ${name}.`);
      return;
    }
    const ran = await migrateUp(pool, { log: msg => console.log(msg) });
    console.log(ran.length ? `Database schema is ready (${ran.length} migration(s) applied).` : 'Database schema is ready (no pending migrations).');
  } finally { await pool.end(); }
}
main().catch(err => { console.error(err.message); process.exit(1); });
