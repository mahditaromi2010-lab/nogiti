-- Reverts 0002_hardening. Deletes only limiter state and secondary indexes; no user/content/order data.
-- web_sessions is intentionally kept: older releases create and use the same table.
DROP INDEX IF EXISTS articles_updated_idx;
DROP INDEX IF EXISTS products_updated_idx;
DROP INDEX IF EXISTS admin_audit_logs_action_idx;
DROP INDEX IF EXISTS users_created_idx;
DROP INDEX IF EXISTS orders_status_created_idx;
DROP INDEX IF EXISTS order_items_product_idx;
DROP TABLE IF EXISTS rate_limit_hits;
