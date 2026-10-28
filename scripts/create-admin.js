require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { validAdminUsername, adminPasswordProblem } = require('../src/admin-security');

async function main() {
  const { DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD, PGSSLMODE } = process.env;
  if (!DATABASE_URL || !ADMIN_USERNAME || !ADMIN_PASSWORD) throw new Error('DATABASE_URL، ADMIN_USERNAME و ADMIN_PASSWORD را در محیط تنظیم کنید.');
  const username = ADMIN_USERNAME.trim().toLowerCase();
  if (!validAdminUsername(username)) throw new Error('ADMIN_USERNAME باید ۳ تا ۶۴ نویسهٔ انگلیسی، عدد، نقطه، خط تیره یا زیرخط باشد.');
  const problem = adminPasswordProblem(ADMIN_PASSWORD, username);
  if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
  if (/^(replace|change)[-_]/i.test(ADMIN_PASSWORD)) throw new Error('ADMIN_PASSWORD هنوز مقدار نمونهٔ .env.example است؛ یک رمز یکتا انتخاب کنید.');
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined });
  try {
    // Schema must be migrated before bootstrap. Re-running this command intentionally rotates the password.
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const result = await pool.query(`INSERT INTO admin_accounts(username,password_hash,role,is_active)
      VALUES($1,$2,'owner',TRUE)
      ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,role='owner',is_active=TRUE,
        session_version=admin_accounts.session_version+1,password_changed_at=NOW(),updated_at=NOW()
      RETURNING id,username`, [username, hash]);
    console.log(`Owner admin account prepared: ${result.rows[0].username} (id ${result.rows[0].id}). Remove ADMIN_PASSWORD from the environment after setup.`);
  } finally { await pool.end(); }
}
main().catch((err) => { console.error(err.message); process.exit(1); });
