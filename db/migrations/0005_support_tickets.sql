-- 0005 support ticket system: customer-facing tickets with a threaded admin/customer conversation.
-- No email notifications are sent anywhere in the app for these tables (per product decision).
-- ROLLBACK: db/migrations/0005_support_tickets.down.sql (drops both new tables; no other data touched).
CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject VARCHAR(200) NOT NULL,
  category VARCHAR(40) NOT NULL DEFAULT 'other' CHECK (category IN ('order','product','account','technical','other')),
  priority VARCHAR(20) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','answered','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tickets_user_idx ON tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status, priority, updated_at DESC);

CREATE TABLE IF NOT EXISTS ticket_messages (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_type VARCHAR(10) NOT NULL CHECK (author_type IN ('user','admin')),
  author_id BIGINT NOT NULL,
  body VARCHAR(4000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages(ticket_id, created_at, id);
