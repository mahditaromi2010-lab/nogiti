-- 0003 team members: admin-editable "About us" team roster (starts empty; no placeholder people).
-- ROLLBACK: db/migrations/0003_team_members.down.sql (drops the table; no other data touched).
CREATE TABLE IF NOT EXISTS team_members (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  role VARCHAR(160) NOT NULL DEFAULT '',
  bio VARCHAR(1200) NOT NULL DEFAULT '',
  photo_path VARCHAR(500) NOT NULL DEFAULT '',
  link_url VARCHAR(500) NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS team_members_order_idx ON team_members(is_active, display_order, id);
