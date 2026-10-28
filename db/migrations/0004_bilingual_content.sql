-- 0004 bilingual content columns (additive; every column nullable/defaulted, existing rows unaffected).
-- English content is optional per row; the app falls back to the Persian column whenever it is empty.
-- The admin edits these through the existing product/article forms once the owner has real English text.
-- ROLLBACK: db/migrations/0004_bilingual_content.down.sql (drops only these new columns).
ALTER TABLE products ADD COLUMN IF NOT EXISTS title_en VARCHAR(180) NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS subtitle_en VARCHAR(240) NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS short_description_en VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS description_en TEXT NOT NULL DEFAULT '';

ALTER TABLE articles ADD COLUMN IF NOT EXISTS title_en VARCHAR(220) NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS excerpt_en VARCHAR(600) NOT NULL DEFAULT '';
ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_en TEXT NOT NULL DEFAULT '';
