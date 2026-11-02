-- 0006 brand rename: display name "Nogiti" -> "Novingity" (visible site_name setting only).
-- Internal/technical identifiers (service name, package name, DB name, etc.) are intentionally untouched.
-- Same idempotent-update pattern as the NUGAS -> Nogiti rename in 0001_baseline.sql.
-- ROLLBACK: db/migrations/0006_brand_rename.down.sql (reverts the setting back to "Nogiti").
UPDATE site_settings SET setting_value = 'Novingity', updated_at = NOW()
  WHERE setting_key = 'site_name' AND setting_value = 'Nogiti';
