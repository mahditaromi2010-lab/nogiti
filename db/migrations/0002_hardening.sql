-- 0002 hardening (additive, non-destructive; no existing row is modified or deleted).
--  * rate_limit_hits: durable failure counter for admin login / OTP verification
--    (pattern from Paradigmshift migration 20261014100000_pg_rate_limit_hits).
--  * web_sessions: created explicitly with the exact DDL connect-pg-simple uses, instead of relying on
--    runtime table creation (which needs CREATE privilege for the app role).
--  * Indexes for the admin filters, ownership checks and dashboard queries.
-- ROLLBACK: db/migrations/0002_hardening.down.sql (drops only limiter rows and indexes; never user data).

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id BIGSERIAL PRIMARY KEY,
  key_hash CHAR(64) NOT NULL,
  hit_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_key_time_idx ON rate_limit_hits(key_hash, hit_at);
CREATE INDEX IF NOT EXISTS rate_limit_hits_time_idx ON rate_limit_hits(hit_at);

DO $$
BEGIN
  IF to_regclass('public.web_sessions') IS NULL THEN
    CREATE TABLE web_sessions (
      sid VARCHAR NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    ALTER TABLE web_sessions ADD CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE;
    CREATE INDEX "IDX_session_expire" ON web_sessions (expire);
  END IF;
END $$;

-- Ownership checks ("has this user paid for product X") filter order_items by product_id.
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items(product_id, order_id);
-- Admin order filters and dashboard counters.
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS users_created_idx ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_action_idx ON admin_audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS products_updated_idx ON products(updated_at DESC);
CREATE INDEX IF NOT EXISTS articles_updated_idx ON articles(updated_at DESC);
