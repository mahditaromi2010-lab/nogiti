-- 0001 baseline: the complete schema shipped in Nugiti-admin-security-final-verified-v2 (db/schema.sql), unchanged.
-- Every statement is idempotent, so it is safe on empty databases AND on databases created by the old schema.sql runner.
-- ROLLBACK: not supported (baseline). Restore from backup instead.
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR(20) UNIQUE NOT NULL,
  first_name VARCHAR(100) NOT NULL DEFAULT '',
  last_name VARCHAR(100) NOT NULL DEFAULT '',
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  branch VARCHAR(80) NOT NULL DEFAULT '',
  field VARCHAR(100) NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGSERIAL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS otp_codes_phone_created_idx ON otp_codes(phone, created_at DESC);
CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  slug VARCHAR(180) UNIQUE NOT NULL,
  title VARCHAR(180) NOT NULL,
  subtitle VARCHAR(240) NOT NULL DEFAULT '',
  product_type VARCHAR(20) NOT NULL CHECK (product_type IN ('course','plugin')),
  category VARCHAR(100) NOT NULL DEFAULT '',
  short_description VARCHAR(500) NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price_toman BIGINT NOT NULL DEFAULT 0 CHECK (price_toman >= 0),
  cover_image VARCHAR(500) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS products_status_type_idx ON products(status, product_type, created_at DESC);
CREATE TABLE IF NOT EXISTS product_assets (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title VARCHAR(180) NOT NULL,
  asset_kind VARCHAR(20) NOT NULL CHECK (asset_kind IN ('video','pdf','download','link')),
  file_key VARCHAR(255) NOT NULL DEFAULT '',
  external_url TEXT NOT NULL DEFAULT '',
  is_preview BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_assets_product_idx ON product_assets(product_id, sort_order, id);
CREATE TABLE IF NOT EXISTS articles (
  id BIGSERIAL PRIMARY KEY,
  slug VARCHAR(180) UNIQUE NOT NULL,
  title VARCHAR(220) NOT NULL,
  excerpt VARCHAR(600) NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  category VARCHAR(100) NOT NULL DEFAULT 'مقالات تخصصی',
  cover_image VARCHAR(500) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS articles_status_date_idx ON articles(status, published_at DESC NULLS LAST);
CREATE TABLE IF NOT EXISTS article_images (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  image_path VARCHAR(500) NOT NULL,
  alt_text VARCHAR(180) NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS article_images_article_idx ON article_images(article_id, sort_order, id);
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  total_toman BIGINT NOT NULL CHECK (total_toman >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
  gateway VARCHAR(30) NOT NULL DEFAULT 'zarinpal',
  authority VARCHAR(100) UNIQUE,
  ref_id VARCHAR(100) NOT NULL DEFAULT '',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  title_snapshot VARCHAR(180) NOT NULL,
  price_toman BIGINT NOT NULL CHECK (price_toman >= 0),
  UNIQUE(order_id, product_id)
);
CREATE TABLE IF NOT EXISTS site_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO site_settings(setting_key, setting_value) VALUES
 ('site_name','Nogiti'),
 ('site_tagline','ابزارهای مهندسی، آموزش تخصصی و منابع تأسیسات'),
 ('contact_email','nugasbnd@gmail.com'),
 ('contact_phone','09033998344'),
 ('instagram','@nugas_bnd'),
 ('about_text','Nogiti بستری برای دسترسی به ابزارهای تخصصی تأسیسات، آموزش مهندسی و منابع کاربردی است.')
ON CONFLICT (setting_key) DO NOTHING;
-- Upgrade the previous default display name without overwriting a custom site name.
UPDATE site_settings SET setting_value='Nogiti', updated_at=NOW() WHERE setting_key='site_name' AND setting_value='NUGAS';
UPDATE site_settings SET setting_value=replace(setting_value,'NUGAS','Nogiti'), updated_at=NOW() WHERE setting_key='about_text' AND setting_value LIKE '%NUGAS%';
CREATE TABLE IF NOT EXISTS admin_credentials (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Security/audit trail: deliberately excludes passwords, OTP values and request bodies.
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(120) NOT NULL,
  method VARCHAR(12) NOT NULL,
  route VARCHAR(500) NOT NULL,
  status_code INTEGER NOT NULL,
  ip_address VARCHAR(80) NOT NULL DEFAULT '',
  user_agent VARCHAR(300) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx ON admin_audit_logs(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_actor_idx ON admin_audit_logs(actor_id, created_at DESC);


-- Dedicated administrative identities are separate from customer accounts and OTP login.
CREATE TABLE IF NOT EXISTS admin_accounts (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(24) NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin','content','orders','users')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_by BIGINT REFERENCES admin_accounts(id) ON DELETE SET NULL,
  last_login_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_accounts_active_idx ON admin_accounts(is_active, role);
ALTER TABLE admin_audit_logs ADD COLUMN IF NOT EXISTS admin_account_id BIGINT REFERENCES admin_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS admin_audit_logs_admin_account_idx ON admin_audit_logs(admin_account_id, created_at DESC);

-- One-time compatibility migration: preserve legacy password hashes while moving admin identities
-- away from customer OTP accounts. Grant owner to only one active legacy administrator; other
-- legacy administrators receive the narrower admin role (never multiple owners by default).
DO $$
BEGIN
  IF to_regclass('public.admin_credentials') IS NOT NULL THEN
    WITH legacy AS (
      SELECT u.id, u.is_active, c.password_hash,
             ROW_NUMBER() OVER (ORDER BY u.is_active DESC, u.id ASC) AS position
      FROM users u
      JOIN admin_credentials c ON c.user_id=u.id
      WHERE u.role='admin'
    )
    INSERT INTO admin_accounts(username, password_hash, role, is_active)
    SELECT 'legacy_admin_' || id::text, password_hash,
           CASE WHEN position=1 THEN 'owner' ELSE 'admin' END, is_active
    FROM legacy
    WHERE NOT EXISTS (SELECT 1 FROM admin_accounts)
    ON CONFLICT (username) DO NOTHING;
  END IF;
END $$;
